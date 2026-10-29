// The "Hide profile picture" switch. For anyone with it on, the app is handed their
// record with no picture in it, so it shows the plain default avatar instead. It is
// a switch of its own: a person can have this on and every other switch off, to
// hide just their picture and nothing else.
//
// Three places are covered; About in settings shows which ones attached:
//   UserStore.getUser           the user record most screens read
//   GuildMemberStore.getMember  a picture set for one particular server
//   the avatar address builder  for anything that builds an address from raw data

import { after } from "@vendetta/patcher";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { anyHidden, diag, mark, onHiddenSetChanged, opt, store } from "./core";

const avatarHidden = (id?: string | null): boolean =>
    !!id && !!store.users?.[id] && opt(id, "hideAvatar");

/** Bumped whenever the hidden set or a switch changes, so cached copies are dropped. */
let generation = 0;
onHiddenSetChanged(() => generation++);

/** What Discord shows for someone with no picture of their own. */
function defaultAvatarUrl(id: string): string {
    let index = 0;
    try {
        index = Number((BigInt(id) >> 22n) % 6n);
    } catch { /* keep 0 */ }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** A copy of a record with some fields blanked. Every descriptor comes along, so the
    methods the app calls on it still work (see the note in stores.ts). */
function blanked(obj: any, fields: string[]): any {
    const copy = Object.create(Object.getPrototypeOf(obj));
    for (const key of Object.getOwnPropertyNames(obj)) {
        const d = Object.getOwnPropertyDescriptor(obj, key);
        if (d) Object.defineProperty(copy, key, d);
    }
    for (const field of fields) {
        if (field in obj)
            Object.defineProperty(copy, field, { value: null, writable: true, enumerable: true, configurable: true });
    }
    return copy;
}

/** Ask the app to redraw after the switch is flipped. Asked twice on purpose. */
export function refreshAvatars() {
    generation++;
    const emit = () => {
        for (const name of ["UserStore", "GuildMemberStore"]) {
            try {
                const s: any = findByStoreName(name);
                s?.emitChange?.();
            } catch (e) {
                console.log("[GhostUsers] refreshAvatars", e);
            }
        }
    };
    emit();
    setTimeout(emit, 400);
}

export function patchAvatars(patches: (() => void)[]) {
    const userMemo: Record<string, { gen: number; from: any; copy: any }> = {};
    const memberMemo: Record<string, { gen: number; from: any; copy: any }> = {};

    /* ---- the user record ---- */
    const UserStore: any = findByStoreName("UserStore");
    if (UserStore && typeof UserStore.getUser === "function") {
        patches.push(
            after("getUser", UserStore, ([userId]: any[], ret: any) => {
                try {
                    if (!ret || !anyHidden()) return ret;
                    const id = String(ret.id ?? userId);
                    if (!avatarHidden(id)) return ret;
                    const cached = userMemo[id];
                    if (cached && cached.gen === generation && cached.from === ret) return cached.copy;
                    const copy = blanked(ret, ["avatar", "avatarDecoration", "avatarDecorationData"]);
                    userMemo[id] = { gen: generation, from: ret, copy };
                    return copy;
                } catch (e) {
                    console.log("[GhostUsers] avatars getUser", e);
                    return ret;
                }
            }),
        );
        mark("avatars.users", true);
    } else {
        mark("avatars.users", false, "UserStore.getUser");
    }

    /* ---- a picture set for one server ---- */
    const Members: any = findByStoreName("GuildMemberStore");
    if (Members && typeof Members.getMember === "function") {
        patches.push(
            after("getMember", Members, ([guildId, userId]: any[], ret: any) => {
                try {
                    if (!ret || !anyHidden()) return ret;
                    const id = String(userId ?? ret.userId);
                    if (!avatarHidden(id) || !ret.avatar) return ret;
                    const key = `${guildId}:${id}`;
                    const cached = memberMemo[key];
                    if (cached && cached.gen === generation && cached.from === ret) return cached.copy;
                    const copy = blanked(ret, ["avatar", "avatarDecoration", "avatarDecorationData"]);
                    memberMemo[key] = { gen: generation, from: ret, copy };
                    return copy;
                } catch (e) {
                    console.log("[GhostUsers] avatars getMember", e);
                    return ret;
                }
            }),
        );
        mark("avatars.members", true);
    } else {
        mark("avatars.members", false, "GuildMemberStore.getMember");
    }

    /* ---- the address builder, for anything made from raw data ---- */
    try {
        const Icons: any = findByProps("getUserAvatarURL");
        if (Icons && typeof Icons.getUserAvatarURL === "function") {
            patches.push(
                after("getUserAvatarURL", Icons, ([user]: any[], ret: any) => {
                    try {
                        const id = user?.id;
                        if (id && anyHidden() && avatarHidden(String(id))) return defaultAvatarUrl(String(id));
                    } catch { /* fall through */ }
                    return ret;
                }),
            );
            diag.patches["avatars.iconUtils"] = "ok · attached";
        } else {
            diag.patches["avatars.iconUtils"] = "ok · not found (not needed if the two above attached)";
        }
    } catch {
        diag.patches["avatars.iconUtils"] = "ok · not found (not needed if the two above attached)";
    }
}
