// Takes the one-on-one chat with chosen hidden people out of the Direct Messages
// list. It is a per-person switch ("Hide from DM list"), off until you turn it on
// for someone. Only 1:1 DMs are touched; group DMs are left alone.
//
// THIS VERSION HUNTS FOR THE REAL SOURCE OF THE LIST. It looks up the DM channel of
// each person with the switch on, then watches the channel-related stores: any list
// (or id-keyed object) that contains that channel gets it taken out, and About in
// settings reports which method it was. Temporary: once the row hides, it gets
// narrowed down to the one method that matters.

import { after } from "@vendetta/patcher";
import * as metro from "@vendetta/metro";
import { findByStoreName } from "@vendetta/metro";
import { diag, mark, onHiddenSetChanged, opt, store } from "./core";

const channelIdOf = (x: any): string | undefined =>
    typeof x === "string" ? x : x?.channelId ?? x?.id;

const shapeOf = (v: any): string =>
    Array.isArray(v)
        ? `array(${v.length})${v.length ? " of " + typeof v[0] : ""}`
        : v && typeof v === "object"
            ? `object(${Object.keys(v).length} keys)`
            : typeof v;

/** every function name on an object and the objects it inherits from */
function methodNames(obj: any): string[] {
    const names: string[] = [];
    let o = obj;
    for (let i = 0; o && o !== Object.prototype && i < 6; i++) {
        for (const k of Object.getOwnPropertyNames(o)) {
            try {
                if (typeof obj[k] === "function" && !names.includes(k)) names.push(k);
            } catch { /* some getters throw */ }
        }
        o = Object.getPrototypeOf(o);
    }
    return names;
}

/* ---- which DM channels are we hiding? ---- */

let generation = 0;
let cacheGen = -1;
let cache: string[] = [];

function targetIds(): string[] {
    if (cacheGen === generation) return cache;
    const CS: any = findByStoreName("ChannelStore");
    const out: string[] = [];
    let users = 0;
    for (const uid of Object.keys(store.users ?? {})) {
        if (!opt(uid, "hideDMRow")) continue;
        users++;
        try {
            const r = CS?.getDMFromUserId?.(uid) ?? CS?.getDMChannelFromUserId?.(uid);
            const id = typeof r === "string" ? r : r?.id;
            if (id) {
                out.push(id);
                continue;
            }
            // fallback: look through the private channels for a 1:1 with this person
            const all = CS?.getMutablePrivateChannels?.() ?? {};
            for (const ch of Object.values<any>(all))
                if (ch?.type === 1 && Array.isArray(ch.recipients) && ch.recipients.includes(uid)) out.push(ch.id);
        } catch { /* nothing to do */ }
    }
    cache = out;
    cacheGen = generation;
    diag.patches["dmTargets"] = `ok · ${users} person(s) with the switch on · ${out.length} DM channel(s) found`;
    return out;
}

/** Ask the DM list to redraw, e.g. right after the switch is flipped. */
export function refreshDMList() {
    generation++;
    try {
        const s: any = findByStoreName("PrivateChannelSortStore") ?? findByStoreName("ChannelStore");
        s?.emitChange?.();
    } catch (e) {
        console.log("[GhostUsers] refreshDMList", e);
    }
}

/* ---- finding the stores ---- */

const STORE_NAME = /channel|private|dm|recent|sort|inbox|conversation|list|read|nav|home|tab|unread|mention|ack/i;
const METHOD_NAME = /^(get|is|has|list|find)/;
const SKIP = new Set([
    "getName", "getDispatchToken", "getChannel", "getDMFromUserId",
    "getDMChannelFromUserId", "getMutableDMSByUserIds", "getDMUserIds",
]);

function allStores(): { stores: any[]; route: string } {
    try {
        const CS: any = findByStoreName("ChannelStore");
        const getAll = CS?.constructor?.getAll;
        if (typeof getAll === "function") {
            const list = getAll.call(CS.constructor);
            if (Array.isArray(list) && list.length) return { stores: list, route: "getAll" };
        }
    } catch { /* try the next route */ }
    try {
        const findAll = (metro as any).findAll;
        if (typeof findAll === "function") {
            const list = findAll((m: any) => {
                try {
                    return typeof m?.getName === "function" && typeof m?.emitChange === "function";
                } catch {
                    return false;
                }
            });
            if (Array.isArray(list) && list.length) return { stores: list, route: "findAll" };
        }
    } catch { /* try the next route */ }
    const named = ["PrivateChannelSortStore", "ChannelStore"].map(n => findByStoreName(n)).filter(Boolean);
    return { stores: named, route: "named only" };
}

let scanning = false;

export function patchDMList(patches: (() => void)[]) {
    const stable: Record<string, any> = {};

    // computed once up front so About shows whether the lookup worked
    targetIds();
    onHiddenSetChanged(refreshDMList);

    const { stores, route } = allStores();
    const patched: string[] = [];
    let methods = 0;

    for (const s of stores) {
        let name = "";
        try {
            name = String(s.getName());
        } catch {
            continue;
        }
        if (!STORE_NAME.test(name)) continue;

        let any = false;
        for (const n of methodNames(s)) {
            if (!METHOD_NAME.test(n) || SKIP.has(n)) continue;
            const hitKey = `dmHit.${name}.${n}`;
            let calls = 0;
            let hits = 0;
            try {
                patches.push(
                    after(n, s, (_args: any[], ret: any) => {
                        calls++;
                        if (scanning || !ret || typeof ret !== "object") return ret;
                        scanning = true;
                        try {
                            const ids = targetIds();
                            if (!ids.length) return ret;

                            if (Array.isArray(ret)) {
                                const kept = ret.filter((e: any) => !ids.includes(channelIdOf(e) as string));
                                if (kept.length === ret.length) return ret;
                                hits++;
                                diag.patches[hitKey] = `ok · HIT · calls ${calls} · hits ${hits} · ${shapeOf(ret)} · hidden from it`;
                                // same contents as last time -> same array, so nothing redraws forever
                                const last = stable[hitKey];
                                if (last && last.length === kept.length && last.every((x: any, i: number) => x === kept[i])) return last;
                                stable[hitKey] = kept;
                                return kept;
                            }

                            const proto = Object.getPrototypeOf(ret);
                            if ((proto === Object.prototype || proto === null) && ids.some(id => id in ret)) {
                                hits++;
                                const filtered = /private|dm|sorted|recent/i.test(n);
                                diag.patches[hitKey] = `ok · HIT · calls ${calls} · hits ${hits} · ${shapeOf(ret)}`
                                    + (filtered ? " · hidden from it" : " · seen only");
                                if (!filtered) return ret;
                                const size = Object.keys(ret).length;
                                const last = stable[hitKey];
                                if (last && last.from === ret && last.gen === generation && last.size === size) return last.copy;
                                const copy: any = {};
                                for (const k of Object.keys(ret)) if (!ids.includes(k)) copy[k] = ret[k];
                                stable[hitKey] = { from: ret, gen: generation, size, copy };
                                return copy;
                            }
                            return ret;
                        } catch (e) {
                            console.log(`[GhostUsers] ${hitKey}`, e);
                            return ret;
                        } finally {
                            scanning = false;
                        }
                    }),
                );
                methods++;
                any = true;
            } catch { /* this one cannot be patched; carry on */ }
        }
        if (any) patched.push(name);
    }

    diag.patches["dmScan"] = `ok · route ${route} · ${methods} methods on ${patched.length} stores: ${patched.join(", ")}`;
    mark("dmList", methods > 0, "could not watch any store");
}
