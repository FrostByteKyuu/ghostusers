// Takes the one-on-one chat with chosen hidden people out of the Direct Messages
// list. It is a per-person switch ("Hide from DM list") and it is off until you turn
// it on for someone. Only 1:1 DMs are touched; group DMs are left alone.
//
// NB: the store and method names in CANDIDATES are best guesses taken from Discord's
// desktop client, not read out of a running Android build. Any that do not exist are
// skipped, and the About section in settings shows which ones attached.

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

    /** Is this list entry (an id, or an object carrying one) a 1:1 DM with someone
        who is hidden AND has the DM-list switch on? */
    const isHiddenDM = (entry: any): boolean => {
        try {
            const id = channelIdOf(entry);
            if (!id) return false;
            const ch = ChannelStore?.getChannel?.(id);
            if (!ch || ch.type !== 1) return false;
            const people = ch.recipients ?? ch.rawRecipients ?? ch.recipientIds;
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
        let described = false;

        patches.push(
            after(method, target, (_args: any[], ret: any) => {
                try {
                    if (!Array.isArray(ret)) return ret;
                    if (!described) {
                        described = true;
                        diag.patches[key] = `ok · ${ret.length ? typeof ret[0] : "empty"} entries`;
                    }
                    if (!anyHidden()) return ret;

                    const kept = ret.filter((e: any) => !isHiddenDM(e));
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
        attached++;
    }

    if (!attached) mark("dmList", false, "no DM list reader found");

    // hiding or un-hiding someone changes what the list should show
    onHiddenSetChanged(refreshDMList);
}
