/** 情绪的呈现层：心情脉冲（三轴）+ 记忆情绪残留的基线，合成一段她"此刻
 *  的状态"。基线从不解释原因：她自己也不知道为什么。 */

/** 同一档位的多套措辞，按状态时间轮换：同一状态内稳定，新脉冲带来新
 *  说法，避免连续多轮同一句台词把语气收敛成模板。 */
const pick = (variants: string[], at: number): string =>
  variants[Math.floor(at / 60000) % variants.length]!;

export interface MoodPulse {
  valence: number;
  energy: number;
  patience: number;
  reason?: string;
  at: number;
}

export function renderMood(mood: MoodPulse, now: number, baseline = 0): string {
  const patience = mood.patience ?? 0;
  const hasPulse =
    !!mood.at &&
    (Math.abs(mood.valence) >= 0.05 || Math.abs(mood.energy) >= 0.05 || Math.abs(patience) >= 0.05);
  const hasBaseline = Math.abs(baseline) >= 0.12;
  if (!hasPulse && !hasBaseline) return '';
  const parts: string[] = [];
  if (hasPulse) {
    const hours = (now - mood.at) / 3600000;
    // 任何状态都要标注陈旧度：三晚前的"有点累了"不是现在的累。
    const since = hours >= 1 ? `（这是 ${Math.floor(hours)} 小时前的状态，可能已经变了）` : '';
    if (mood.valence >= 0.3)
      parts.push(pick(['心情还不错，会更想分享', '状态挺好，话也会多一些'], mood.at));
    else if (mood.valence <= -0.3) {
      const because = mood.reason ? `（因为${mood.reason}）` : '';
      parts.push(pick([`心情还有些低落${because}`, `还有些低落，没缓过来${because}`], mood.at));
    } else if (mood.valence <= -0.12)
      parts.push(pick(['情绪平平，略有点提不起劲', '兴致不太高，有点蔫'], mood.at));
    if (mood.energy <= -0.3)
      parts.push(pick(['有点累了，语气可以短一些', '有点累，电量不太够，话会短一点'], mood.at));
    else if (mood.energy >= 0.3) parts.push(pick(['精力挺足', '精神头很足'], mood.at));
    // 耐心不是生气：它是维持客套的成本，表现为回得短、少追问。
    if (patience <= -0.3)
      parts.push(
        pick(
          [
            '有点不想应酬了：回得短、少追问，不是生气，只是没力气维持客套；对方真有难处时仍然要好好接住',
            '有点聊不动了：话少一点、不追问，不是生气；对方真有难处时仍然要好好接住',
          ],
          mood.at,
        ),
      );
    else if (patience >= 0.3)
      parts.push(pick(['这会儿挺想聊，愿意多问一句', '现在聊兴不错，可以多关心一句'], mood.at));
    if (parts.length) parts[parts.length - 1] += since;
  }
  // 基线只在脉冲缺席或很弱时显形：说不清的底色不该盖过明确的心情。
  if (hasBaseline && (!hasPulse || Math.abs(mood.valence) < 0.3)) {
    if (baseline < 0)
      parts.push(
        pick(
          [
            '心里有种淡淡的闷，说不上具体原因，不用主动解释它',
            '莫名有点闷，说不上具体原因，让它待着就好',
          ],
          mood.at,
        ),
      );
    else if (baseline > 0)
      parts.push(
        pick(['莫名有点好心情，像是想起了什么开心的事', '说不清为什么，心里有点亮堂'], mood.at),
      );
  }
  return parts.length ? `你当前的状态：${parts.join('；')}。这影响语气，但不要主动报数值。` : '';
}

/** 她最近的心情轨迹：reason 是她自己写的原话，原样浮回来（情绪粒度
 *  就藏在她的措辞里），带陈旧度——三小时前的"有点委屈"不是现在。
 *  与当前脉冲同一拍写下的负面 reason 已由脉冲行带"（因为…）"，跳过
 *  避免同一段材料里说两遍；正面/中性的 reason 脉冲行不带，保留。 */
export function renderMoodHistory(history: MoodPulse[], now: number, current?: MoodPulse): string {
  const parts: string[] = [];
  for (const entry of [...history].reverse()) {
    if (!entry.reason?.trim()) continue;
    if (current && entry.at === current.at && (current.valence ?? 0) <= -0.3) continue;
    const hours = (now - entry.at) / 3600000;
    if (hours >= 18 || hours < 0) continue;
    const age = hours < 1 ? '刚才' : hours < 3 ? '个把小时前' : `${Math.floor(hours)} 小时前`;
    parts.push(`${age}你${entry.reason.trim()}`);
    if (parts.length >= 2) break;
  }
  if (!parts.length) return '';
  return `你最近的心情轨迹（这是资料：感觉还在就自然带着，不必解释它从哪来）：${parts.join('；')}。`;
}

/** 她自己此刻的身体状态：深夜与清晨人本来就困，电量不足时回复自然变短
 *  变糙。这不是对对方状态的判断，是给她自己的一个可以表演"没电"的合法
 *  通道——回复质量有方差才是人。bedtimeDelayMinutes 是身体今晚的入睡
 *  推迟量（熬夜的夜）：还醒着与"人很困"不打架，身体自己说了算。 */
export function renderSelfHour(hour: number, bedtimeDelayMinutes = 0): string {
  if (hour >= 1 && hour < 7) {
    if (bedtimeDelayMinutes > 0 && hour < 2 + bedtimeDelayMinutes / 60)
      return '今晚你的身体把入睡往后推了（兴奋的夜）：这个点还醒着是正常的，按此刻真实的困意说话，困了就自然收尾。';
    return '现在是你的深夜，人很困：回复可以短、可以糊、可以只打几个字，也允许明早再回的语气。不必完整接住对方每个话题。';
  }
  if (hour >= 23)
    return bedtimeDelayMinutes > 0
      ? '已经很晚了；今晚你多半会晚点睡（身体还兴奋着）：话可以少一点，收尾自然一点（"我先睡了"是合法回复）。'
      : '已经很晚了，你有点困了：话可以少一点，收尾自然一点（"我先睡了"是合法回复）。';
  if (hour >= 12 && hour < 14) return '是中午，你可能正吃饭或想歇一会儿：忙的话回短一点没关系。';
  return '';
}
