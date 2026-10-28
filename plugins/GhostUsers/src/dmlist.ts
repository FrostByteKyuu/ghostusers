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
const stable: Record<string, any> = {};

/** One watcher per store method. It has to be its own function: a callback made
    inside a loop was handed the wrong variables on this engine (the label came out
    as "undefined" and the counters as NaN), so everything it needs is passed in. */
function watch(patches: (() => void)[], s: any, storeName: string, method: string): boolean {
    const hitKey = `dmHit.${storeName}.${method}`;
    const hideObjects = /private|dm|sorted|recent|conversation|list/i.test(`${storeName}.${method}`);
    let calls = 0;
    let hits = 0;
    try {
        patches.push(
            after(method, s, (_args: any[], ret: any) => {
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
                    if ((proto === Object.prototype || proto === null) && ids.some((id: string) => id in ret)) {
                        hits++;
                        diag.patches[hitKey] = `ok · HIT · calls ${calls} · hits ${hits} · ${shapeOf(ret)}`
                            + (hideObjects ? " · hidden from it" : " · seen only");
                        if (!hideObjects) return ret;
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
        return true;
    } catch {
        return false; // this one cannot be patched; carry on
    }
}

export function patchDMList(patches: (() => void)[]) {
    // computed once up front so About shows whether the lookup worked
    targetIds();
    onHiddenSetChanged(refreshDMList);

    const { stores, route } = allStores();
    const patched: string[] = [];
    let methods = 0;

    for (const s of stores) {
        let storeName = "";
        try {
            storeName = String(s.getName());
        } catch {
            continue;
        }
        if (!STORE_NAME.test(storeName)) continue;

        let any = false;
        for (const method of methodNames(s)) {
            if (!METHOD_NAME.test(method) || SKIP.has(method)) continue;
            if (watch(patches, s, storeName, method)) {
                methods++;
                any = true;
            }
        }
        if (any) patched.push(storeName);
    }

    diag.patches["dmScan"] = `ok · route ${route} · ${methods} methods on ${patched.length} stores: ${patched.join(", ")}`;
    mark("dmList", methods > 0, "could not watch any store");
}
