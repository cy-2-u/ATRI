/** 情绪的三个来源合成一段她"此刻的状态"：
 *  1. 心情脉冲（三轴：愉悦/精力/耐心）——对话事件与模型自评，小时级衰减；
 *  2. 记忆的情绪残留——想起来了什么，此刻就有感觉（运行时已做成脉冲）；
 *  3. 情绪基线——残留按意义加权的底色。基线从不解释原因：她自己也不知道。 */

/** 同一档位的多套措辞，按状态时间轮换：同一状态内稳定，新脉冲带来新
 *  说法，避免连续多轮同一句台词把语气收敛成模板。所有变体保留稳定的
 *  语义关键词，调用方与测试按关键词断言。 */
const pick = (variants: string[], at: number): string =>
  variants[Math.floor(at / 60000) % variants.length]!;

export function renderMood(
  mood: { valence: number; energy: number; patience?: number; reason?: string; at: number },
  now: number,
  baseline = 0,
): string {
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
