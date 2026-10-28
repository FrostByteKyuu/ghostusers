// Takes the one-on-one chat with chosen hidden people out of the Direct Messages
// list. It is a per-person switch ("Hide from DM list"), off until you turn it on
// for someone. Only 1:1 DMs are touched; group DMs are left alone.
//
// The app builds the DM list from two places, found by watching the whole client:
//   PrivateChannelSortStore.getPrivateChannelIds   a list of channel ids
//   ChannelStore.getMutablePrivateChannels         an object keyed by channel id
// Both get the hidden chat taken out. Nothing else is watched.

import { after } from "@vendetta/patcher";
import { findByStoreName } from "@vendetta/metro";
import { diag, mark, onHiddenSetChanged, opt, store } from "./core";

const channelIdOf = (x: any): string | undefined =>
    typeof x === "string" ? x : x?.channelId ?? x?.id;

/* ---- which DM channels are we hiding? ---- */

let generation = 0;
let cacheGen = -1;
let cache: string[] = [];

/** True while this file is looking things up, so its own lookups are not filtered. */
let busy = false;

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

/** Ask the app to redraw the DM list. Asked twice, because one ask is sometimes
    not picked up until later. */
export function refreshDMList() {
    generation++;
    const emit = () => {
        for (const name of ["PrivateChannelSortStore", "ChannelStore"]) {
            try {
                const s: any = findByStoreName(name);
                s?.emitChange?.();
            } catch (e) {
                console.log("[GhostUsers] refreshDMList", e);
            }
        }
    };
    emit();
    setTimeout(emit, 400);
}

/* ---- the two places the list comes from ---- */

/** A list of channel ids (or channels) with the hidden chat taken out. */
function hideFromList(patches: (() => void)[], storeName: string, method: string) {
    const key = `dmList.${storeName}.${method}`;
    const target: any = findByStoreName(storeName);
    if (!target || typeof target[method] !== "function") {
        mark(key, false, `${storeName}.${method}`);
        return;
    }
    let last: any[] | null = null;
    patches.push(
        after(method, target, (_args: any[], ret: any) => {
            if (busy || !Array.isArray(ret)) return ret;
            busy = true;
            try {
                const ids = targetIds();
                if (!ids.length) return ret;
                const kept = ret.filter((e: any) => !ids.includes(channelIdOf(e) as string));
                if (kept.length === ret.length) return ret;
                // same contents as last time -> same array, so nothing redraws forever
                if (last && last.length === kept.length && last.every((x: any, i: number) => x === kept[i])) return last;
                last = kept;
                return kept;
            } catch (e) {
                console.log(`[GhostUsers] ${key}`, e);
                return ret;
            } finally {
                busy = false;
            }
        }),
    );
    mark(key, true);
}

/** An object keyed by channel id, with the hidden chat's key taken out. */
function hideFromMap(patches: (() => void)[], storeName: string, method: string) {
    const key = `dmList.${storeName}.${method}`;
    const target: any = findByStoreName(storeName);
    if (!target || typeof target[method] !== "function") {
        mark(key, false, `${storeName}.${method}`);
        return;
    }
    let memo: { from: any; gen: number; size: number; copy: any } | null = null;
    patches.push(
        after(method, target, (_args: any[], ret: any) => {
            if (busy || !ret || typeof ret !== "object" || Array.isArray(ret)) return ret;
            busy = true;
            try {
                const ids = targetIds();
                if (!ids.length || !ids.some((id: string) => id in ret)) return ret;
                const size = Object.keys(ret).length;
                if (memo && memo.from === ret && memo.gen === generation && memo.size === size) return memo.copy;
                const copy: any = {};
                for (const k of Object.keys(ret)) if (!ids.includes(k)) copy[k] = ret[k];
                memo = { from: ret, gen: generation, size, copy };
                return copy;
            } catch (e) {
                console.log(`[GhostUsers] ${key}`, e);
                return ret;
            } finally {
                busy = false;
            }
        }),
    );
    mark(key, true);
}

export function patchDMList(patches: (() => void)[]) {
    targetIds(); // looked up once up front, so About shows whether it worked
    onHiddenSetChanged(refreshDMList);
    hideFromList(patches, "PrivateChannelSortStore", "getPrivateChannelIds");
    hideFromMap(patches, "ChannelStore", "getMutablePrivateChannels");
}
