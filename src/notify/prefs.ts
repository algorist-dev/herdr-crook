// iPhone が決める通知の設定（NotificationPrefs）。Mac（APNs）とアプリが同じ決まりで出すかどうかを決める。
// 規則（shouldNotify・shouldSound）は iPhone 側（ios/CrookKit/Sources/CrookKit/NotificationPrefs.swift）と同じ表をテストで見張る。
export interface NotificationPrefs {
  enabled: boolean;
  onlyWhenAway: boolean;
  onlyNeedsInput: boolean;
  sound: boolean;
  suppressFocused: boolean;
  /** 鳴らさない時間（nil なら無し）。start・end は分（0〜1439）。start より end が小さければ日をまたぐ */
  quiet: { start: number; end: number; timeZone: string } | null;
  /** 知らせないワークスペース（workspaceId） */
  mutedWorkspaces: string[];
  /** 返事待ちのままこの分数がたったら、もう 1 回だけ知らせる（null なら知らせない） */
  remindAfterMinutes: number | null;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  onlyWhenAway: true,
  onlyNeedsInput: false,
  sound: true,
  suppressFocused: true,
  quiet: null,
  mutedWorkspaces: [],
  remindAfterMinutes: null,
};

const WORKSPACE_ID = /^[A-Za-z0-9_]{1,64}$/;

/** iPhone から来た prefs の中身を確かめる（無いキーは既定、key 自体が無ければ undefined） */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const bool = (key: string, fallback: boolean) => {
    if (m[key] === undefined) return fallback;
    if (typeof m[key] !== "boolean") return null;
    return m[key];
  };
  const enabled = bool("enabled", DEFAULT_PREFS.enabled);
  const onlyWhenAway = bool("onlyWhenAway", DEFAULT_PREFS.onlyWhenAway);
  const onlyNeedsInput = bool("onlyNeedsInput", DEFAULT_PREFS.onlyNeedsInput);
  const sound = bool("sound", DEFAULT_PREFS.sound);
  const suppressFocused = bool("suppressFocused", DEFAULT_PREFS.suppressFocused);
  if (enabled === null || onlyWhenAway === null || onlyNeedsInput === null || sound === null || suppressFocused === null) return undefined;
  let quiet: NotificationPrefs["quiet"] = null;
  if (m.quiet !== undefined && m.quiet !== null) {
    const q = m.quiet as Record<string, unknown>;
    if (typeof q !== "object" || q === null) return undefined;
    if (!isQuietMinute(q.start) || !isQuietMinute(q.end)) return undefined;
    if (typeof q.timeZone !== "string" || q.timeZone.length === 0 || q.timeZone.length > 64) return undefined;
    // Intl で読めなければ鳴らさない時間を無いことにする（受けは捨てない）
    if (!timeZoneKnown(q.timeZone) || q.start === q.end) quiet = null;
    else quiet = { start: q.start, end: q.end, timeZone: q.timeZone };
  }
  let mutedWorkspaces: string[] = [];
  if (m.mutedWorkspaces !== undefined) {
    if (!Array.isArray(m.mutedWorkspaces) || m.mutedWorkspaces.length > 200) return undefined;
    if (!m.mutedWorkspaces.every((id) => typeof id === "string" && WORKSPACE_ID.test(id))) return undefined;
    mutedWorkspaces = m.mutedWorkspaces as string[];
  }
  let remindAfterMinutes: number | null = null;
  if (m.remindAfterMinutes !== undefined && m.remindAfterMinutes !== null) {
    const v = m.remindAfterMinutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 240) return undefined;
    remindAfterMinutes = v;
  }
  return {
    enabled,
    onlyWhenAway,
    onlyNeedsInput,
    sound,
    suppressFocused,
    quiet,
    mutedWorkspaces,
    remindAfterMinutes,
  };
}

function isQuietMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;
}

/** Intl（ECMA-402）で読める時刻の名前か */
function timeZoneKnown(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** 知らせる種類。APNs の payload の kind と同じ名前 */
export type AttentionKind = "needs-input" | "finished";

/**
 * out＝この知らせを出すか。
 * - awayFromMac：Mac が決める（isAway）。分からなければ true（知らせない方に倒さない）
 * - focusedWorkspace：この端末でいま開いているワークスペース（アプリが出すときだけ。Mac が送るときは null）
 */
export function shouldNotify(
  prefs: NotificationPrefs,
  kind: AttentionKind,
  workspaceId: string,
  awayFromMac: boolean,
  focusedWorkspace: string | null,
): boolean {
  if (!prefs.enabled) return false;
  if (prefs.onlyNeedsInput && kind === "finished") return false;
  if (prefs.onlyWhenAway && !awayFromMac) return false;
  if (prefs.suppressFocused && focusedWorkspace !== null && focusedWorkspace === workspaceId) return false;
  if (prefs.mutedWorkspaces.includes(workspaceId)) return false;
  return true;
}

/** 鳴らすか：sound がオンで、鳴らさない時間の外のとき */
export function shouldSound(prefs: NotificationPrefs, now: Date): boolean {
  return prefs.sound && !inQuietHours(prefs, now);
}

/**
 * 鳴らさない時間の中か（APNs を passive にする）。start ちょうどは中、end ちょうどは外。
 * start == end と、読めない時刻の名前は、鳴らさない時間が無いことにする
 */
export function inQuietHours(prefs: NotificationPrefs, now: Date): boolean {
  const quiet = prefs.quiet;
  if (quiet === null || quiet.start === quiet.end) return false;
  let tz: Intl.DateTimeFormat;
  try {
    tz = new Intl.DateTimeFormat("en", { timeZone: quiet.timeZone, hour: "numeric", minute: "numeric", hour12: false });
  } catch {
    return false;
  }
  const match = /(\d{1,2}):(\d{2})/.exec(tz.format(now));
  if (!match) return false;
  const minuteOfDay = (Number(match[1]) % 24) * 60 + Number(match[2]);
  if (quiet.start > quiet.end) return minuteOfDay >= quiet.start || minuteOfDay < quiet.end;
  return minuteOfDay >= quiet.start && minuteOfDay < quiet.end;
}
