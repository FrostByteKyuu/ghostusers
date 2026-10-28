// Takes the one-on-one chat with chosen hidden people out of the Direct Messages
// list. It is a per-person switch ("Hide from DM list") and it is off until you turn
// it on for someone. Only 1:1 DMs are touched; group DMs are left alone.
//
// THIS VERSION ALSO REPORTS WHAT IT SEES: the About section in settings now lists
// which store methods the app really calls, how often, and what they return. That is
// how the right one gets found. It is temporary and comes out once the row hides.

import { after } from "@vendetta/patcher";
import { findByStoreName } from "@vendetta/metro";
import { anyHidden, diag, isHidden, mark, onHiddenSetChanged, opt } from "./core";

const userIdOf = (x: any): string | undefined => (typeof x === "string" ? x : x?.id);
const channelIdOf = (x: any): string | undefined =>
    typeof x === "string" ? x : x?.channelId ?? x?.id;

const CANDIDATES: [string, string][] = [
    ["PrivateChannelSortStore", "getPrivateChannelIds"],
    ["PrivateChannelSortStore", "getSortedChannels"],
    ["ChannelStore", "getSortedPrivateChannels"],
];

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

/** Ask the DM list to redraw, e.g. right after the switch is flipped. */
export function refreshDMList() {
    try {
        const s: any = findByStoreName("PrivateChannelSortStore") ?? findByStoreName("ChannelStore");
        s?.emitChange?.();
    } catch (e) {
        console.log("[GhostUsers] refreshDMList", e);
    }
}

export function patchDMList(patches: (() => void)[]) {
    const ChannelStore: any = findByStoreName("ChannelStore");
    let sampled = false;

    /** Is this list entry (an id, or an object carrying one) a 1:1 DM with someone
        who is hidden AND has the DM-list switch on? */
    const isHiddenDM = (entry: any): boolean => {
        try {
            const id = channelIdOf(entry);
            if (!id) return false;
            const ch = ChannelStore?.getChannel?.(id);
            if (!ch || ch.type !== 1) return false;
            const people = ch.recipients ?? ch.rawRecipients ?? ch.recipientIds;
            if (!sampled) {
                sampled = true;
                diag.patches["dmSample"] = `ok · first 1:1 DM: recipients=${shapeOf(people)}`
                    + ` · rawRecipients=${shapeOf(ch.rawRecipients)} · recipientIds=${shapeOf(ch.recipientIds)}`;
            }
            if (!Array.isArray(people)) return false;
            return people.some((r: any) => {
                const uid = userIdOf(r);
                return !!uid && isHidden(uid) && opt(uid, "hideDMRow");
            });
        } catch {
            return false;
        }
    };

    let attached = 0;
    for (const [storeName, method] of CANDIDATES) {
        const target: any = findByStoreName(storeName);
        if (!target || typeof target[method] !== "function") continue;

        const key = `dmList.${method}`;
        let last: any[] | null = null;
        let calls = 0;

        patches.push(
            after(method, target, (_args: any[], ret: any) => {
                try {
                    calls++;
                    if (!Array.isArray(ret)) {
                        diag.patches[key] = `ok · calls ${calls} · returns ${shapeOf(ret)}`;
                        return ret;
                    }
                    const kept = anyHidden() ? ret.filter((e: any) => !isHiddenDM(e)) : ret;
                    diag.patches[key] =
                        `ok · calls ${calls} · ${shapeOf(ret)} · removed ${ret.length - kept.length}`;
                    if (kept.length === ret.length) return ret;

                    // Same contents as last time -> same array. The app reads this
                    // constantly, and a fresh array every call can make it redraw
                    // forever.
                    if (last && last.length === kept.length && last.every((x, i) => x === kept[i])) return last;
                    last = kept;
                    return kept;
                } catch (e) {
                    console.log(`[GhostUsers] ${key}`, e);
                    return ret;
                }
            }),
        );
        mark(key, true);
        diag.patches[key] = "ok · attached, not called yet";
        attached++;
    }

    if (!attached) mark("dmList", false, "no DM list reader found");

    /* ---- the probe: what do these stores have, and which of it does the app use? ---- */
    const PROBE = /private|sorted|dm|recent/i;
    for (const name of ["PrivateChannelSortStore", "ChannelStore"]) {
        try {
            const s: any = findByStoreName(name);
            if (!s) {
                diag.patches[`dmProbe.${name}`] = "ok · store not found";
                continue;
            }
            const names = methodNames(s).filter(n => PROBE.test(n));
            diag.patches[`dmProbe.${name}`] = `ok · ${names.join(", ") || "none"}`;
            for (const n of names) {
                if (CANDIDATES.some(([sn, m]) => sn === name && m === n)) continue;
                let calls = 0;
                patches.push(
                    after(n, s, (_args: any[], ret: any) => {
                        calls++;
                        diag.patches[`dmSpy.${name}.${n}`] = `ok · calls ${calls} · ${shapeOf(ret)}`;
                        return ret;
                    }),
                );
            }
        } catch (e) {
            console.log(`[GhostUsers] probe ${name}`, e);
        }
    }

    // hiding or un-hiding someone changes what the list should show
    onHiddenSetChanged(refreshDMList);
}
