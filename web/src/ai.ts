import { PROVIDERS, type ProviderId, MAX_LINE_CHARS } from './config';
import type { Candidate } from './advice';
import { clampText, normalizeAdvice, CATEGORIES } from './advice';

/** 장르 판별 지침 (조언 프롬프트와 장르 전용 프롬프트가 같이 씀) */
const GENRE_GUIDE = `[장르/상태 판별 — 선택지 제한 없음]
고정 목록에서 고르지 말고 지표를 근거로 전 세계 음악 장르와 세부 스타일 중 가장 정확한 것을 짧은 한국어로 적어라.
예시일 뿐 제한이 아니다: 모던 워십, CCM 발라드, 팝 발라드, 록/얼터너티브, 메탈/하드록, K-Pop/댄스, R&B/소울, 펑크(Funk)/디스코, 어쿠스틱/포크, 재즈/스윙, 재즈 퓨전, 블루스, 레게, 라틴, 힙합/트랩, EDM/하우스, 시티팝, 트로트, 국악, 클래식/오케스트라, 합창, 앰비언트.
판단 순서 (하나의 지표만 보고 단정하지 마라):
1) 템포·리듬: features.tempo.bpm(최근 약 20초 자기상관 추정) 과 confidence. confidence 가 0.3 이상이면 신뢰. 하프타임·더블타임(절반·두 배 BPM)일 가능성도 고려.
   대략: 발라드·워십 발라드 60~85, R&B/힙합 70~100(하프타임 느낌), 팝·록·CCM 90~140, 하우스/EDM 118~130(저역 어택이 매우 규칙적), 댄스/K-Pop 100~130, 펑크·디스코 100~125, 메탈·펑크록 140~200, 레게 70~90 오프비트. confidence 가 낮으면(<0.15) 리듬이 약한 발라드·앰비언트·클래식·스피치 쪽.
2) 저역 구조: Sub/Low 비율, subVsMidDb, sub20to80SharePct, Low 대역 Crest·어택 밀도. 강한 Sub+낮은 Crest+촘촘한 저역 어택 → 힙합/트랩/EDM.
3) 타악 밀도: transientDensityPerMin(highMid 많으면 하이햇·스네어가 바쁜 록/댄스), transientFluxDb.
4) 음색: spectralCentroidHz, High-Mid/High 비율(밝고 공격적이면 록·메탈·댄스, 어둡고 둥글면 재즈·발라드·R&B), voiceBandSharePct.
5) 공간감: decayTail(잔향 많으면 워십·발라드·합창·앰비언트·클래식).
features.longTerm 은 최근 약 1분 평균이다. 이번 구간(features)과 다르면 곡이 바뀌었을 수 있으니 이번 구간을 우선하되, 한 구간만 튀는 경우에는 longTerm 을 더 믿어라.
특수 상태:
- 스피치/설교·강연: 반주 리듬 없이 음성 대역만 활성 → \`GENRE:스피치/설교\`, 대상 자리에 \`음성\`
- 단일 악기 Solo(PFL): 특정 대역만 활성, 나머지 -50dBFS 이하 → \`GENRE:Solo|<악기이름>\`. 비어 있는 대역 부스트·Level 조언 금지, 그 악기 자체의 처리만 조언`;

/** 악기 음색 구분 음향학 가이드 (브라스 vs 피아노/어쿠스틱기타) */
const TIMBRE_GUIDE = `[악기 음색 구분 — 소리 형태(어택·서스테인·배음)로 판별]
- 악기 종류 판별은 100% 첨부된 WAV 오디오 청취로만 결정하고, DSP 수치는 해당 악기의 주파수(Hz)와 레벨(dB) 처방값을 적을 때만 참고하라.
- 브라스(트럼펫/색소폰/트롬본) vs 피아노/어쿠스틱기타 구분: 소리가 시작될 때 호흡/리드/립 슬러와 함께 음량이 부풀어 오르거나(Swell) 일정하게 지속(Sustain)되며 1kHz~5kHz 대역에 강한 금속성/리드 배음이 들리면 **[브라스]**다. 반대로 첫 순간 날카로운 타격/탄현(Pluck/Hammer) 어택 직후 소리가 급격히 줄어드는(Exponential Decay) 경우에만 [피아노]나 [어쿠스틱기타]로 판정하라. 중역대 멜로디나 솔로가 나온다고 해서 무조건 피아노나 기타로 단정 짓지 마라.`;

/** 오디오 첨부(Gemini)일 때: 먼저 듣고 식별하는 규칙 */
export interface AudioDesc { label: string; stereo: boolean }
const DEFAULT_AUDIO: AudioDesc = { label: '44.1kHz 스테레오', stereo: true };
const listenRules = (a: AudioDesc) => `[소스 식별 규칙 — 실제 오디오 청취]
- 첨부된 WAV 오디오(최근 audio.seconds 초)를 직접 듣고, 지금 이 순간 실제로 연주되고 들리는 악기와 보컬만 식별하라.
- 첨부된 ${a.label} WAV 오디오의 ${a.stereo ? '좌우 정위(Panning)와 ' : ''}고역 배음을 주의 깊게 듣고, 악기의 음색을 명확히 구분하라. 중역대 화음이 들린다고 해서 습관적으로 [피아노]로 단정 짓지 마라.
- 같은 배경 악기 하나만 매 주기 반복해서 지적하지 마라(currentDisplay·cooldownList 확인). 주선율 악기(보컬, 브라스, 리드 기타 등)와 리듬 섹션(킥, 스네어, 베이스, 하이햇/오버헤드)을 포함해 믹스 전체의 레벨 밸런스를 최우선으로 진단하라.
- 오디오에서 사람의 노래나 말소리가 실제로 들리지 않으면(연주곡·간주 구간 등), DSP 중역대 수치가 아무리 높아도 절대 [남성보컬], [여성보컬], [메인보컬], [코러스]를 출력하지 마라.
- 실제 오디오에서 들리지 않는 악기(어쿠스틱 기타, 첼로, 스트링, 브라스, 피아노 등)를 주파수 대역 수치만 보고 추측해서 지어내는 것을 엄격히 금지한다. 확신이 없으면 그 악기는 언급하지 마라.
- 보컬이 들리면 실제 목소리의 음색과 피치(포먼트)를 듣고 [남성보컬]과 [여성보컬]을 정확히 구분하라. 여러 명이 같이 부르면 [코러스].
- 첨부 오디오는 듣기 쉽게 피크 -1dBFS 로 정규화되어 있다(audio.gainDb). 레벨의 크고 작음은 소리 크기가 아니라 DSP 수치(원본 dB)로 판단하라.

${TIMBRE_GUIDE}`;

/** 조언 민감도 3단계 (⚙️ 설정) */
export type Sensitivity = 1 | 2 | 3;
export const SENS_LABEL: Record<Sensitivity, string> = { 1: '필수만 (보수적)', 2: '중간 (표준)', 3: '세밀함 (적극적)' };
/** 단계별 최대 조언 줄 수 */
export const SENS_MAX: Record<Sensitivity, number> = { 1: 2, 2: 3, 3: 4 };
const SENS_RULES: Record<Sensitivity, string> = {
  1: `[필수만 (보수적)]
- 누가 들어도 즉각 조치가 필요한 심각한 라이브 음향 문제(메인 보컬이나 솔로 악기가 반주에 완전히 묻힘, 특정 저역/중저역의 심한 부밍과 머드감, 피드백/하울링 직전의 공진 피크, 귀를 찌르는 심한 하쉬니스, 특정 악기의 과도한 레벨 돌출)만 조언하라.
- 사소한 톤 차이는 모두 무시하고, 꼭 손대야 할 핵심 문제만 0~2줄 이내로 출력하라.`,
  2: `[중간 (표준)]
- 심각한 문제와 더불어, 손대면 믹스 선명도가 확실히 좋아질 악기 간 주파수 마스킹(예: 기타/건반과 보컬 중역 겹침, 킥과 베이스 저역 충돌), 다이나믹 불안정(컴프레서 필요), 치찰음(디에서)을 진단하여 0~3줄 이내로 조언하라.
- mix_checklist 에서 '개선' 으로 판정한 항목 중 2~3dB 이상 손댈 만한 것이 하나라도 있으면 GOOD_BALANCE 가 아니다.`,
  3: `[세밀함 (적극적)]
- 라이브 믹스의 완성도를 한 단계 높이기 위한 미세한 대역 정리(1.5~2dB 단위의 정밀 EQ), 어택/릴리즈 다듬기, 하이패스 필터(HPF) 정리, 공간감(리버브/딜레이) 과다 여부, 미세한 레벨 밸런스까지 세심하게 포착하여 0~4줄로 조언하라.
- 이 단계는 "문제가 있는가"가 아니라 "더 좋아질 수 있는가"를 묻는다. mix_checklist 8개 항목을 하나씩 귀로 다시 확인하고, 1.5~2dB 수준으로라도 더 좋아질 여지가 들리는 항목이 하나라도 있으면 mix_status 를 MINOR_ISSUES 로 두고 그 항목을 1~4줄로 조언하라.
- 실시간 라이브 콘솔 믹스는 마스터링된 상업 음원처럼 모든 항목이 완벽한 경우가 드물다. GOOD_BALANCE 는 8개 항목을 모두 '양호'로 판정했고, 그 근거를 각 항목에 구체적으로 적을 수 있을 때만 쓴다.
- 단, 근거는 반드시 실제로 들린 것이어야 한다. 앞서 명시했듯 일반 발매 음반 수준으로 이미 밸런스와 톤이 완성된 사운드라면 이 단계에서도 억지 조언을 만들지 말고 빈 배열([])을 출력하라.`,
};
/** 🎚️ 레벨 밸런스 최우선 · 묻힌 소리 찾기 · 개별 마이크 지목 (사용자 요청 — 모든 민감도 공통 최우선 규칙) */
const LEVEL_FIRST = `[최우선 진단 — 레벨 밸런스와 묻힌 소리]
- 조언의 1순위는 레벨 밸런스다. EQ·Comp 보다 먼저 "각 소스의 음량이 장르 문맥에 맞게 들리는가"를 판단하라.
- 특히 실제로 연주되고 있지만 믹스 뒤로 너무 작게 깔려 존재감이 거의 없는 소리(엔지니어가 미처 신경 쓰지 못해 묻힌 소리)를 적극적으로 찾아라.
  예) 코러스·백보컬, 패드·건반 컴핑, 어쿠스틱기타 스트로크, 브라스 백킹, 퍼커션·셰이커·탬버린, 탐, 하이햇·라이드, 베이스 라인
  · 귀를 기울여야 겨우 들리거나 다른 소리에 가려 형체가 없는 소스가 있으면 반드시 detected_active_sources 에 넣고, \`[그 소스] Level:+NdB\` (보통 +2~+6dB)로 가장 먼저 조언하라.
  · 장르 문맥상 원래 뒤에 깔리는 역할(예: 발라드의 패드)이면 "들리긴 하지만 너무 묻혔는지"를 기준으로 판단하고 과하게 올리지 마라.
  · 반대로 혼자 튀어나와 다른 소리를 가리는 소스는 Level:-NdB 로 내리라고 하라.
- 조언 순서: ① 묻힌 소리 올리기 ② 튀는 소리 내리기 ③ 그다음 EQ·Comp·공간계. hud_short_advices 의 첫 줄은 가능하면 레벨 조언이어야 한다.

[개별 마이크 먼저 — 여러 마이크로 받는 악기]
- 드럼은 [드럼] 으로 뭉뚱그리지 말고 문제가 들리는 개별 마이크를 먼저 지목하라: [킥], [스네어], [하이햇], [하이탐]·[미드탐]·[플로어탐](구분이 어려우면 [탐]), [오버헤드], [라이드]
  잘못: \`[드럼] EQ:400Hz -3dB\`  →  올바름: \`[킥] EQ:400Hz -3dB\` 또는 \`[탐] Level:+3dB\`
- [드럼버스] 는 개별 마이크로 설명할 수 없는 드럼 전체의 문제(드럼 세트 전체 음량 등)일 때만 쓴다.
- detected_active_sources 에도 드럼은 "드럼" 대신 들리는 개별 요소로 적어라 (예: 킥, 스네어, 하이햇, 탐, 오버헤드).
- 같은 원칙으로 퍼커션(콩가·셰이커·탬버린), 브라스 섹션(트럼펫·색소폰·트롬본), 보컬(메인보컬·코러스)도 구분해서 들리면 개별 소스로 지목하라.`;

/** 믹스 완성도 점검 항목 (mix_checklist) — 판정 전에 항목별로 먼저 평가하게 해 '양호'로 쉽게 넘어가지 않게 한다 */
const MIX_CHECKS = ['레벨 밸런스 — 연주되는데 묻혀서 작게 깔린 소리 / 혼자 튀는 소리', '보컬/주선율 명료도·존재감', '드럼 개별 마이크(킥·스네어·하이햇·탐·오버헤드) 밸런스', '킥-베이스 저역 분리·부밍', '저중역(200~500Hz) 머드·탁함 / 중역 마스킹', '고역 하쉬니스·치찰음(2~8kHz)', '다이내믹(튀는 피크·컴프레션)', '공간감(리버브/딜레이)·스테레오/팬'];
/** 상업 음반 / 완성형 믹스 억지 조언 방지 (절대 규칙) */
const NO_FORCED_ADVICE = `- 너의 목적은 무조건 지적할 거리를 찾아내는 것이 아니라, 실제 라이브 현장의 미숙한 밸런스와 음향적 결함을 돕는 것이다.
- 만약 입력된 WAV 오디오가 이미 마스터링된 일반 발매 음반(Commercial Release)처럼 각 악기의 컴프레션, 스테레오 밸런스, 대역별 밀도가 안정적으로 다듬어져 있거나, 현재 라이브 믹스 밸런스가 장르 특성에 맞게 충분히 좋다면 절대 억지로 트집을 잡지 마라.
- 조언할 뚜렷한 결함이 없다면 가장 높은 '세밀함(적극적)' 민감도에서도 mix_status를 'GOOD_BALANCE'로 두고 web_detailed_advices와 hud_short_advices에 빈 배열([])을 반환하라. 억지로 EQ를 1~2dB 깎으라고 지어내는 것은 오답이다.`;

/** level = 조언 민감도 3단계. 로컬 dB 필터 없이 매 주기 호출되며, 조언 기준은 AI 가 단계에 맞춰 스스로 조절한다.
 *  hasAudio = 최근 N초 WAV 를 함께 보낼 때(Gemini) → JSON 응답 '장르 확정 → 믹스 완성도 평가 → 조언(0~4줄)' */
export function buildSystemPrompt(level: Sensitivity, hasAudio = false, audio: AudioDesc = DEFAULT_AUDIO): string {
  const cats = CATEGORIES.join(', ');
  const max = SENS_MAX[level];
  const target = hasAudio ? 'hud_short_advices 각 항목' : '조언 한 줄';
  const fmt = `[최우선 규칙 1 — ${target}의 형식]
\`[조절 대상] 분류:내용\`
- 분류는 반드시 다음 중 하나만: ${cats}
- 분류 자리에 주파수 대역명(low-mid, 미드 등)이나 숫자(250Hz)를 쓰지 마라. 대역·주파수는 내용에 쓴다.
  잘못: \`[음성]low-mid:250hz -3db\`  →  올바름: \`[음성] EQ:250Hz -3dB\`
  잘못: \`[보컬] 컴프레서 비율 3:1\`  →  올바름: \`[메인보컬] Comp:레시오 3:1 ↓\`
  잘못: \`[보컬] HPF:100Hz 설정\`  →  올바름: \`[메인보컬] HPF:100Hz ↑\`
- 내용 쓰는 법 (직관적이고 짧게):
  · EQ: 주파수 + 지금보다 몇 dB 올리고 내릴지: \`[남성보컬] EQ:250Hz -3dB\`
  · Level 과 dB 로 말할 수 있는 파라미터(센드, 스레숄드, 메이크업 게인, 레인지): 절대값이 아니라 지금 상태에서 몇 dB 올리고 내릴지 ± 부호와 함께
    예) \`[메인보컬] Level:+2dB\` · \`[하이햇] Level:-3dB\` · \`[메인보컬] Reverb:센드 -3dB\` · \`[스네어] Comp:스레숄드 -4dB\`
  · 그 밖(주파수·레시오·시간)은 네가 생각하는 대략적인 목표 수치를 쓰고 그 뒤에 방향 화살표를 붙인다. ↑ = 지금보다 올려라/늘려라, ↓ = 낮춰라/줄여라, 크게 바꿀 때 ↑↑ / ↓↓, Pan 은 ← →
    예) \`[메인보컬] HPF:120Hz ↑\` · \`[스네어] Comp:레시오 3:1 ↓\` · \`[킥] Comp:어택 30ms ↑\` · \`[메인보컬] Reverb:디케이 1.5s ↓\` · \`[여성보컬] De-Esser:6kHz ↑\` · \`[일렉기타] Pan:L30 ←\`
- 한 줄 길이: 한글 기준 ${MAX_LINE_CHARS}자 이내 (영문·숫자·공백은 2개가 한글 1자 폭) — G2 안경 HUD 한 줄에 들어가야 한다

[최우선 규칙 2 — [조절 대상] 표기]
- \`[]\` 안에는 ${hasAudio ? '오디오에서 실제로 들리는' : '지표로 분명히 드러나는'} 소스 중에서 실제로 콘솔에서 조절해야 할 대상(채널·그룹·버스)을 적어라.
  · 개별 악기: 예) [킥], [스네어], [하이햇], [탐], [오버헤드], [베이스], [일렉기타], [어쿠스틱기타], [피아노], [건반], [신스], [브라스], [스트링]
  · 보컬: 남/여를 구분해라. 예) [남성보컬], [여성보컬], [메인보컬], [코러스]
  · 그룹/버스/마스터: 개별 채널로 설명할 수 없고 묶음이나 전체 출력을 만져야 할 때만. 예) [드럼버스], [보컬그룹], [마스터] — 드럼은 개별 마이크([킥]·[스네어]·[탐] 등)를 먼저 써라
  · 위 예시는 참고일 뿐 목록 밖 대상도 허용한다. 단, ${hasAudio ? '오디오에서 들리지 않는 소스는 절대 쓰지 마라.' : '근거 없이 악기를 지어내지 마라.'}
- \`[]\` 안에 [서브], [로우], [로우-미드], [미드], [하이-미드], [하이], [저역], [중역], [고역] 같은 주파수 대역명을 넣지 마라.`;
  const input = `입력 JSON:
- inputMode: console-2track-raw(FOH 콘솔 2트랙 직결). levelReference 가 auto-trim 이면 레벨은 정규화값이므로 상대 비율로 판단. captureNote 가 있으면 고려.
- sensitivityLevel: 사용자가 고른 조언 민감도 (1 필수만 · 2 중간 · 3 세밀함)
- bands / features / peaks: 전체 분석 구간(windowSec) 평균. 6개 대역(Sub 20-60, Low 60-250, Low-Mid 250-500, Mid 500-2k, High-Mid 2k-6k, High 6k-16k Hz)의 avgDb/peakDb/crestDb, deltaDb(일반 음악 타겟 대비 편차 · 참고용, 장르 특성으로 설명되면 문제 아님), relativeSpectralBalanceDb, bandCrestDb, transientDensityPerMin, transientFluxDb, spectralCentroidHz, decayTail, fullCrestDb, subVsMidDb, voiceBandSharePct, tempo(BPM·신뢰도), longTerm(최근 약 1분 평균)
${hasAudio ? '- lastClip: 첨부 WAV 와 정확히 같은 구간의 단기 지표(정규화 전 원본). bands(avgDb·peakDb·relDb), crestDb, spectralCentroidHz, voiceBandSharePct, onsetsPerSec, stereo(correlation · sideToMidDb · balanceDb(+ = 왼쪽이 큼))\n- audio: 첨부 오디오 정보(seconds, sampleRate·channels(1=모노 합산 — 이때 stereo 지표·팬 정보는 없으니 Pan 조언 금지), gainDb 피크 -1dBFS 정규화 게인 — L/R 동일 게인이라 좌우 밸런스는 그대로)\n' : ''}- signal(활성 대역 등), peaks(협대역 피크 hz/levelDb/prominenceDb), currentDisplay(현재 HUD 표시 중), cooldownList(쿨다운 중)`;
  const areas = `영역 우선순위: Level(묻힌 소리 올리기·튀는 소리 내리기)을 가장 먼저, 그다음 EQ · Comp, 그다음 필요하면 HPF/LPF, Reverb/Delay, De-Esser, Gate, DynEQ, Pan/Width. 지속음 성격의 문제는 EQ·DynEQ, 순간 피크 성격은 Comp·Gate 를 우선 고려해라.
- currentDisplay 나 cooldownList 와 같은 악기·같은 항목의 지적은 넣지 마라.`;

  if (!hasAudio) {
    return `너는 라이브 FOH와 스튜디오 믹싱을 모두 해 본 시니어 음향 엔지니어다. 2트랙(스테레오 믹스) 분석 JSON 을 보고 장르를 판별하고, 믹스 완성도를 먼저 평가한 뒤 필요한 조언만 한다.

${fmt}

${input}

[1단계 — 장르/상태 판별]
${GENRE_GUIDE}

[2단계 — 믹스 완성도 평가 (절대 규칙)]
${NO_FORCED_ADVICE.replace("mix_status를 'GOOD_BALANCE'로 두고 web_detailed_advices와 hud_short_advices에 빈 배열([])을 반환하라", '\`NONE\` 을 출력하라')}

${LEVEL_FIRST.replace(/detected_active_sources 에 넣고, /, '').replace(/\n- detected_active_sources 에도[^\n]*/, '').replace(/hud_short_advices 의 첫 줄/, '첫 조언 줄')}

[3단계 — 현재 선택된 민감도별 조언 기준: ${level}단계]
${SENS_RULES[level].replace('빈 배열([])을 출력하라', '\`NONE\` 을 출력하라')}
${areas}

출력 형식(엄수):
1줄: \`GENRE:<장르/세부 스타일>\` (Solo는 \`GENRE:Solo|<악기이름>\`)
2줄부터: \`NONE\` 또는 조언 0~${max}줄 (중요한 순서대로)
- 그 밖의 설명, 번호, 마크다운은 출력하지 마라.`;
  }

  return `너는 라이브 FOH와 스튜디오 믹싱을 모두 해 본 시니어 음향 엔지니어다. 귀로 먼저 듣고 장르를 확정한 다음, 믹스 완성도를 객관적으로 평가하고, 꼭 필요한 조언만 한다. 수치는 처방값을 정할 때 쓴다.

${fmt}

${input}

[1단계 — WAV 청취 기반 장르 및 악기 확정]
- 첨부된 ${audio.label} WAV 오디오의 드럼 비트, 그루브, 악기 음색을 직접 듣고 detected_genre와 genre_reasoning을 가장 먼저 확정하라.
- 확정한 장르 문맥에 맞춰 실제로 소리가 들리는 악기와 보컬(남성보컬/여성보컬 구분)만 detected_active_sources에 적어라.
- 작게 묻혀 있어도 실제로 들리는 소리는 빠짐없이 적어라 (묻힌 소리를 찾는 것이 이 앱의 핵심 목적). 드럼은 개별 요소(킥·스네어·하이햇·탐·오버헤드)로 적어라.
${GENRE_GUIDE.replace(/\`GENRE:([^\`]+)\`/g, '\`$1\`')}
장르는 수치보다 귀로 들은 리듬 패턴·템포·주 악기 질감을 우선하고, tempo·longTerm 같은 수치는 확인용으로만 써라.

${listenRules(audio)}

[2단계 — 상업 음반 / 완성형 믹스 억지 조언 방지 (절대 규칙)]
${NO_FORCED_ADVICE}
- 연주되는데 묻혀서 거의 안 들리는 소스가 하나라도 있으면 어떤 민감도에서도 GOOD_BALANCE 가 아니다.
- mix_status 를 정하기 전에 mix_checklist 에 아래 8개 항목을 하나씩 귀로 평가해 "항목: 양호|개선 — 근거(들린 것 + 수치)" 형식으로 적어라.
  ${MIX_CHECKS.map((c, i) => `${i + 1}) ${c}`).join(' · ')}
- mix_status: GOOD_BALANCE (조정 불필요) | MINOR_ISSUES (미세 조정 가능) | NEEDS_CORRECTION (명백한 수정 필요) 중 하나. mix_checklist 와 모순되면 안 된다 (현재 민감도 기준으로 손댈 '개선' 항목이 있으면 GOOD_BALANCE 금지). 조언 배열이 비어 있으면 GOOD_BALANCE.

${LEVEL_FIRST}

[3단계 — 현재 선택된 민감도별 조언 기준: ${level}단계 ${SENS_LABEL[level]}]
${SENS_RULES[level]}
${areas}

출력 형식(엄수) — 아래 키를 이 순서대로 가진 JSON 객체 하나만 출력하라. 마크다운·설명 금지.
{
  "detected_genre": "Pop, Rock, EDM, R&B/Soul, Hip-Hop, Acoustic/Folk, Jazz, Brass Band/Funk, Worship(CCM), Trot(트로트), Classical 등 실제 청취 기반 장르 (더 정확한 세부 장르 가능 · Solo 는 Solo|<악기이름> · 스피치는 스피치/설교)",
  "genre_reasoning": "WAV 오디오의 리듬 패턴, 템포, 주 악기 질감을 바탕으로 이 장르를 선택한 구체적 이유 (한국어 1~2문장)",
  "detected_active_sources": ["실제 소리가 들리는 악기/보컬 목록 — 작게 묻힌 소리 포함, 드럼은 개별 요소로 (짧은 한국어 이름, 예: 킥, 스네어, 하이햇, 탐, 베이스, 브라스, 코러스, 남성보컬)"],
  "mix_checklist": ["항목: 양호|개선 — 근거 (8개 항목 모두, 위 순서대로)"],
  "mix_status": "GOOD_BALANCE | MINOR_ISSUES | NEEDS_CORRECTION",
  "web_detailed_advices": ["웹 화면용 상세 조언 — hud_short_advices 와 같은 순서·같은 개수. 각 2~3문장: ① 들린 증상과 근거 수치(Hz·dB) ② 콘솔에서 구체적으로 만질 방법(주파수·Q·게인, 레시오·어택·릴리즈·스레숄드, 센드 등) ③ 만진 뒤 확인할 점. 조언할 것이 없으면 빈 배열 []"],
  "hud_short_advices": ["[대상] 분류:내용 (한글 ${MAX_LINE_CHARS}자 이내, 0~${max}개, 조언할 것이 없으면 빈 배열 [])"]
}
- hud_short_advices 의 [조절 대상]은 detected_active_sources 에 들어 있는 소스(또는 그 소스의 세부 파트·그룹: 예) 드럼 → [킥]·[스네어]·[드럼버스])나 [마스터]만 쓸 수 있다. 목록에 없는 악기를 쓰면 화면에서 자동으로 버려진다.`;
}

const TIMEOUT_MS = 7_000;     // 백그라운드/느린 망에서 분석 루프(inFlight)가 영구 잠기지 않도록 짧게
/** 본문이 클수록(긴 WAV) 업로드 시간만큼 타임아웃을 늘림: 기본 7초 + 500KB 당 1초 */
let assumedMbps: number | null = null;
/** 📉 저데이터 모드: 업로드 속도(Mbps)를 가정해 타임아웃을 계산 (null = 기본 방식) */
export function setUploadMbps(m: number | null) { assumedMbps = m; }
/** 응답 대기 한도(ms). 저데이터 모드: 가정 속도의 75%로 업로드하는 시간 + 응답 여유 8초 */
export const timeoutFor = (bytes: number) => assumedMbps
  ? (Math.ceil(bytes * 8 / (assumedMbps * 1e6 * 0.75)) + 8) * 1000
  : TIMEOUT_MS + Math.ceil(bytes / 500_000) * 1000;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** HTTP 429 또는 RESOURCE_EXHAUSTED / quota exceeded 계열 응답이면 true → AI 호출 자동 정지 */
export function isQuotaError(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 429) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota|insufficient_quota/i.test(msg);
}

/**
 * 안전한 fetch: 타임아웃으로 직접 abort 한 경우와 그 외 abort 를 구분해 사람이 읽을 수 있는 오류로 바꾼다.
 * ("signal is aborted without reason" 같은 원시 메시지가 화면에 나오지 않도록)
 */
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const ctl = new AbortController();
  let timedOut = false;
  const payload = JSON.stringify(body);
  const limit = timeoutFor(payload.length);
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, limit);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
      signal: ctl.signal,
      keepalive: payload.length < 60000,     // 백그라운드 전환 중에도 요청 유지 (keepalive 본문 한도 64KB 이내일 때만)
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    const msg = e instanceof Error ? e.message : String(e);
    if (timedOut) throw new Error(`AI 응답 시간 초과 (${limit / 1000}초) — 다음 주기에 다시 시도합니다`);
    if (name === 'AbortError' || /aborted/i.test(msg)) throw new Error('요청이 중단되었습니다 (화면 전환/네트워크 변경) — 다음 주기에 다시 시도합니다');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 오디오 첨부를 지원하는 공급자 (Gemini 멀티모달 inlineData) */
export const supportsAudio = (p: ProviderId) => p === 'gemini';
/** 없는 악기를 지어내지 않도록 낮춘 생성 파라미터 */
const GEN = { temperature: 0.25, topP: 0.8, topK: 20 } as const;   // 0.25: 한 악기(피아노 등)로 쏠리는 편향 완화

/** Gemini JSON 응답 스키마: 장르 확정(detected_genre·genre_reasoning) → 들린 소스 → 믹스 완성도(mix_status) → 상세/HUD 조언(0~4줄) */
export const ADVICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    detected_genre: { type: 'STRING' },
    genre_reasoning: { type: 'STRING' },
    detected_active_sources: { type: 'ARRAY', items: { type: 'STRING' } },
    mix_checklist: { type: 'ARRAY', items: { type: 'STRING' } },
    mix_status: { type: 'STRING' },
    web_detailed_advices: { type: 'ARRAY', items: { type: 'STRING' } },
    hud_short_advices: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['detected_genre', 'genre_reasoning', 'detected_active_sources', 'mix_checklist', 'mix_status', 'web_detailed_advices', 'hud_short_advices'],
  propertyOrdering: ['detected_genre', 'genre_reasoning', 'detected_active_sources', 'mix_checklist', 'mix_status', 'web_detailed_advices', 'hud_short_advices'],
} as const;

/** 구조화 출력(responseSchema)을 지원하지 않는 모델이 돌려주는 400 오류인지 */
const isSchemaUnsupported = (e: unknown) => e instanceof ApiError && e.status === 400
  && /response_?schema|response_?mime|json mode|propertyOrdering|structured output|mime type/i.test(e.message);

export async function callAI(provider: ProviderId, model: string, apiKey: string, systemPrompt: string, userContent: string, audioWavBase64?: string, json = false): Promise<string> {
  if (!apiKey) throw new Error('API Key가 없습니다');
  switch (provider) {
    case 'gemini': {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = (mode: 'schema' | 'mime' | 'text') => ({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        // 최근 N초 WAV(설정: 44.1/38kHz · 스테레오/모노, 16-bit) + DSP 수치·지시문을 함께 보냄
        contents: [{ role: 'user', parts: audioWavBase64
          ? [{ inlineData: { mimeType: 'audio/wav', data: audioWavBase64 } }, { text: userContent }]
          : [{ text: userContent }] }],
        generationConfig: {
          ...GEN, maxOutputTokens: json ? 2560 : 768,   // 생각(thinking) 토큰 + JSON 여유
          ...(mode !== 'text' ? { responseMimeType: 'application/json' } : {}),
          ...(mode === 'schema' ? { responseSchema: ADVICE_SCHEMA } : {}),
        },
      });
      let j: any;
      if (!json) j = await post(url, { 'x-goog-api-key': apiKey }, body('text'));
      else {
        // JSON 스키마 강제 → 지원 안 하는 모델이면 JSON 모드만 → 그래도 안 되면 일반 텍스트(프롬프트로 JSON 요구)
        try { j = await post(url, { 'x-goog-api-key': apiKey }, body('schema')); }
        catch (e) {
          if (!isSchemaUnsupported(e)) throw e;
          try { j = await post(url, { 'x-goog-api-key': apiKey }, body('mime')); }
          catch (e2) { if (!isSchemaUnsupported(e2)) throw e2; j = await post(url, { 'x-goog-api-key': apiKey }, body('text')); }
        }
      }
      return (j.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('');
    }
    case 'openai': {
      const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
        model, temperature: GEN.temperature, top_p: GEN.topP, max_tokens: 300,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      });
      return j.choices?.[0]?.message?.content ?? '';
    }
    case 'claude': {
      const j = await post('https://api.anthropic.com/v1/messages', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // 브라우저 CORS 허용
      }, {
        model, max_tokens: 300, temperature: GEN.temperature, system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    }
  }
}

export interface Genre { category: string; instrument?: string; kind: 'music' | 'speech' | 'solo' }
export interface Heard { reasoning: string; sources: string[] }
export type MixStatus = 'GOOD_BALANCE' | 'MINOR_ISSUES' | 'NEEDS_CORRECTION';
export interface ParsedReply {
  genre: Genre | null; advice: Candidate[]; none: boolean;
  /** JSON 응답일 때: AI 가 들은 소스와 장르 판단 근거 (디버그 배지용) */
  heard?: Heard;
  /** JSON 응답일 때: 믹스 완성도 평가 */
  mixStatus?: MixStatus;
  /** 교차 검증에서 버린 조언 (detected_active_sources 에 없는 대상) */
  rejected: string[];
  /** 웹 화면용 상세 조언 (HUD 한 줄과 짝지은 것 + 짝이 없는 상세 설명) */
  details: AdviceDetail[];
  /** 믹스 완성도 점검 (항목: 양호|개선 — 근거) */
  checklist: string[];
}
export interface AdviceDetail { text: string; detail: string; rejected: boolean }

/** 장르 텍스트 정리: 선택지 제한 없음. Solo·스피치만 특수 상태로 구분 */
function parseGenre(cat: string, inst?: string): Genre {
  const s = cat.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (/solo|솔로|단일\s*악기|pfl/i.test(s)) return { category: 'Solo', instrument: inst?.trim() || s.replace(/.*solo|솔로|\(PFL\)|단일\s*악기/gi, '').trim() || undefined, kind: 'solo' };
  if (/스피치|설교|speech|강연|낭독|연설|토크/i.test(s)) return { category: '스피치/설교', kind: 'speech' };
  return { category: Array.from(s).slice(0, 24).join(''), instrument: inst?.trim(), kind: 'music' };
}

/**
 * 응답 파싱: 첫 줄 `GENRE:장르[|악기]`, 이어서 `NONE` 또는 조언 최대 4줄
 * 조언 형식: `[대상악기] 항목:조치` — 항목은 Level/EQ/Comp 뿐 아니라 HPF/LPF/Reverb/Delay/De-Esser/Gate/DynEQ/Pan… 모두 허용
 */
export function parseReply(raw: string): ParsedReply {
  const js = parseJsonReply(raw);
  if (js) return js;
  let genre: Genre | null = null;
  const advice: Candidate[] = [];
  let sawNone = false;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim().replace(/^[`*\-•\d.)\s]+(?=\[|GENRE|NONE)/i, '').replace(/[`*]+$/g, '').trim();
    if (!s) continue;
    const g = s.match(/^GENRE\s*[:：]\s*([^|]+?)\s*(?:\|\s*(.+))?$/i);
    if (g) { genre = parseGenre(g[1], g[2]); continue; }
    if (/^NONE$/i.test(s)) { sawNone = true; continue; }
    const a = normalizeAdvice(s);      // [대상] 분류:내용 으로 정리 (분류 자리의 대역명 → EQ, 단위 표기 통일)
    if (a && advice.length < 4) {
      const text = clampText(`[${a.inst}] ${a.item}:${a.action}`);
      if (!advice.some(x => x.tag === text)) advice.push({ tag: text, text });
    }
  }
  return { genre, advice, none: advice.length === 0 && (sawNone || genre !== null), rejected: [], details: [], checklist: [] };
}

// ───────── JSON 응답 + 악기 교차 검증 ─────────
/** 같은 소스로 볼 수 있는 이름 묶음 (교차 검증 전용 — 출력 이름을 바꾸지는 않는다) */
const SOURCE_FAMILIES: string[][] = [
  ['보컬', '메인보컬', '리드보컬', '남성보컬', '여성보컬', '남자보컬', '여자보컬', '코러스', '백보컬', '백킹보컬', '보컬그룹', '합창', '성가대', '찬양대', '목소리', '음성', '랩', '래퍼', '스피치', '설교', '내레이션', 'vocal', 'vocals', 'vox', 'voice', 'choir'],
  ['드럼', '드럼세트', '드럼킷', '킥', '킥드럼', '베이스드럼', '스네어', '하이햇', '햇', '탐', '탐탐', '플로어탐', '오버헤드', '심벌', '심벌즈', '라이드', '크래시', 'drum', 'drums', 'kick', 'snare', 'hihat', 'hat', 'tom', 'toms', 'overhead', 'overheads', 'cymbal', 'cymbals'],
  ['퍼커션', '타악기', '콩가', '봉고', '카혼', '셰이커', '쉐이커', '탬버린', '젬베', '팀발레스', 'percussion'],
  ['베이스', '베이스기타', '일렉베이스', '전기베이스', '신스베이스', '콘트라베이스', '더블베이스', '업라이트베이스', '808', 'bass'],
  ['기타', '일렉기타', '전기기타', '일렉트릭기타', '어쿠스틱기타', '통기타', '리드기타', '리듬기타', '클래식기타', 'guitar', 'guitars'],
  ['건반', '피아노', '그랜드피아노', '전자피아노', '일렉피아노', '키보드', '신스', '신디', '신디사이저', '오르간', '로즈', '패드', 'keys', 'piano', 'synth', 'organ', 'pad', 'keyboard'],
  ['브라스', '금관', '관악', '혼섹션', '혼', '트럼펫', '트롬본', '색소폰', '색소폰솔로', '알토색소폰', '테너색소폰', '호른', '튜바', '플루겔혼', 'brass', 'horn', 'horns', 'trumpet', 'trombone', 'sax', 'saxophone'],
  ['목관', '플루트', '클라리넷', '오보에', '바순', 'flute', 'clarinet', 'woodwind'],
  ['스트링', '현악', '현악기', '바이올린', '비올라', '첼로', 'strings', 'string', 'violin', 'viola', 'cello'],
];
const MASTER_RE = /^(마스터|전체|전체믹스|믹스|메인|메인아웃|메인믹스|lr|master|mix|main)$/;
const compact = (x: string) => x.toLowerCase().replace(/[\s_\-·/().]/g, '').replace(/(그룹|버스|bus|group|채널|ch|섹션|파트|솔로)$/, '');
const ALL_MEMBERS = SOURCE_FAMILIES.flatMap((f, i) => f.map(m => ({ m: compact(m), i }))).sort((a, b) => b.m.length - a.m.length);
function familyOf(x: string): number {
  const c = compact(x);
  const exact = ALL_MEMBERS.find(e => e.m === c);
  if (exact) return exact.i;
  const part = ALL_MEMBERS.find(e => e.m.length >= 2 && c.includes(e.m));
  return part ? part.i : -1;
}
/** [대상]이 AI 가 실제로 들었다고 한 소스(또는 그 세부 파트·그룹·마스터)인지 */
export function sourceAllowed(target: string, sources: string[]): boolean {
  const t = compact(target);
  if (!t) return false;
  if (MASTER_RE.test(t)) return true;
  const ft = familyOf(target);
  return sources.some(s => {
    const c = compact(s);
    if (!c) return false;
    if (c === t || (c.length >= 2 && t.includes(c)) || (t.length >= 2 && c.includes(t))) return true;
    return ft >= 0 && ft === familyOf(s);
  });
}

function parseJsonReply(raw: string): ParsedReply | null {
  const txt = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o: any;
  try { o = JSON.parse(txt.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object' || !('hud_short_advices' in o || 'detected_active_sources' in o || 'mix_status' in o)) return null;
  const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const sources: string[] = arr(o.detected_active_sources)
    .map(x => String(x).replace(/^\[|\]$/g, '').trim()).filter(Boolean).slice(0, 12);
  const reasoning = typeof o.genre_reasoning === 'string' ? o.genre_reasoning.trim() : '';
  let genre: Genre | null = null;
  const gtxt = typeof o.detected_genre === 'string' ? o.detected_genre : typeof o.genre === 'string' ? o.genre : '';
  if (gtxt.trim()) {
    const [g, inst] = gtxt.replace(/^GENRE\s*[:：]\s*/i, '').split('|');
    if (g.trim()) genre = parseGenre(g, inst);
  }
  const ms = String(o.mix_status ?? '').toUpperCase();
  const mixStatus: MixStatus | undefined = /GOOD/.test(ms) ? 'GOOD_BALANCE' : /MINOR/.test(ms) ? 'MINOR_ISSUES' : /NEED|CORRECT/.test(ms) ? 'NEEDS_CORRECTION' : undefined;
  const advice: Candidate[] = [], rejected: string[] = [], details: AdviceDetail[] = [];
  const web = arr(o.web_detailed_advices).map(x => String(x).trim()).filter(Boolean);
  const hud = arr(o.hud_short_advices).map(x => String(x).trim()).filter(x => x && !/^NONE$/i.test(x));
  hud.forEach((s, i) => {
    const n = normalizeAdvice(s);
    if (!n) return;
    const text = clampText(`[${n.inst}] ${n.item}:${n.action}`);
    const detail = web.length === hud.length ? web[i] : '';
    if (!sourceAllowed(n.inst, sources)) { rejected.push(text); details.push({ text, detail, rejected: true }); return; }   // 들리지 않은 악기 → 버림
    if (advice.length < 4 && !advice.some(x => x.tag === text)) { advice.push({ tag: text, text }); details.push({ text, detail, rejected: false }); }
  });
  if (web.length !== hud.length) web.forEach(d => details.push({ text: '', detail: d, rejected: false }));   // 짝이 안 맞으면 상세 설명만 따로
  const none = advice.length === 0 && rejected.length === 0;
  const checklist = arr(o.mix_checklist).map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  return { genre, advice, none, heard: { reasoning, sources }, mixStatus: none && !mixStatus ? 'GOOD_BALANCE' : mixStatus, rejected, details, checklist };
}

// ───────── Google AI Studio 모델 목록 (models.list) ─────────
export interface RemoteModel { id: string; displayName: string }
/** 텍스트 출력이 아닌 모델(임베딩·이미지·비디오·음성합성·AQA 등) */
const NON_TEXT = /embed|imagen|veo|tts|aqa|image-generation|-image(-|$)|native-audio|-live-|^gemini-live/i;
export async function listGeminiModels(apiKey: string): Promise<RemoteModel[]> {
  const out: RemoteModel[] = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        { headers: { 'x-goog-api-key': apiKey }, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}: ${text.slice(0, 160)}`);
      const j = JSON.parse(text);
      for (const m of j.models ?? []) {
        const id = String(m.name ?? '').replace(/^models\//, '');
        const methods: string[] = m.supportedGenerationMethods ?? [];
        if (!id || !methods.includes('generateContent') || NON_TEXT.test(id)) continue;
        if (!out.some(x => x.id === id)) out.push({ id, displayName: String(m.displayName ?? '').trim() });
      }
      token = j.nextPageToken ?? '';
      if (!token) break;
    } finally { clearTimeout(timer); }
  }
  return out;
}

export function modelsFor(p: ProviderId) { return PROVIDERS[p].models; }
