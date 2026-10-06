/**
 * 自動継続が立てる後継（Claude の会話、Codex のタスク）の名前。
 *
 * 形は「project 名｜作業の概要（自動引き継ぎ）」。一覧を見た時に、どの project の、何の作業の続きかを読める
 * ようにする。作業の概要は前任の題から取り、AI は呼ばない。前任の題が取れない時は project 名と印だけにする。
 */

export const AUTO_HANDOFF_TITLE_MARK = '自動引き継ぎ';
const SEPARATOR = '｜';
const SUFFIX = `（${AUTO_HANDOFF_TITLE_MARK}）`;
// 一覧の幅で末尾の印が切れにくい長さに、概要を抑える。
const SUMMARY_MAX_CHARS = 40;
// 継続の指示（Claude・Codex とも、この語と引き継ぎ ID で始まる）。名前の付いていない後継は、これが題として見える。
const CONTINUATION_INPUT_PATTERN = /^Throughline自動継続 [0-9a-f]{8}-/;

/** project の場所から、名前に使うフォルダ名を取る。Windows の場所を他の OS で読んでも同じ値にする。 */
export function autoHandoffProjectName(projectPath) {
  if (typeof projectPath !== 'string') return '';
  return oneLine(projectPath.split(/[\\/]+/).filter(Boolean).at(-1) ?? '');
}

function oneLine(text) {
  // 起動の引数として渡すので、制御文字と改行を落とす。二重引用符は Windows の引数の受け渡しで崩れるので落とす。
  return text.replace(/[\u0000-\u001f\u007f"]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('').trimEnd()}…`;
}

/**
 * 前任の題や依頼から、作業の概要を取る。前任がこの形の名前を持つ後継なら、中の概要だけを取り出す
 * （引き継ぎを重ねても、project 名と印が積み重ならない）。概要にならない値は null。
 */
export function autoHandoffSummaryOf(title) {
  if (typeof title !== 'string') return null;
  const firstLine = title.split(/\r?\n/).map(oneLine).find(Boolean) ?? '';
  if (!firstLine || CONTINUATION_INPUT_PATTERN.test(firstLine)) return null;
  if (firstLine.endsWith(SUFFIX)) {
    const body = firstLine.slice(0, -SUFFIX.length);
    const at = body.indexOf(SEPARATOR);
    const inner = at < 0 ? '' : body.slice(at + SEPARATOR.length).trim();
    return inner ? clip(inner, SUMMARY_MAX_CHARS) : null;
  }
  return clip(firstLine, SUMMARY_MAX_CHARS);
}

/**
 * 後継の名前を作る。
 * @param {{projectPath: string, titles?: Array<string|null|undefined>}} input titles は概要の候補（先頭から使えるものを採る）
 */
export function composeAutoHandoffTitle({ projectPath, titles = [] }) {
  const project = autoHandoffProjectName(projectPath);
  const summary = titles.map(autoHandoffSummaryOf).find(Boolean) ?? null;
  return [project, summary].filter(Boolean).join(SEPARATOR) + SUFFIX;
}
