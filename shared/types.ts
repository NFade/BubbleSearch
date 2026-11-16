// Контракт между сервером (server/) и интерфейсом (web/).
// Только типы: файл импортируется через `import type`, рантайм-кода здесь быть не должно.

/** Кошелёк из списка отслеживания (экспорт Axiom, нормализованный). */
export interface TrackedWallet {
  address: string;
  name: string;
  emoji: string;
  /** Ключ сущности: нормализованное имя без суффиксов (Side, DEV, цифры). Кошельки одного человека имеют общий entity. */
  entity: string;
  /** Отображаемое имя сущности. */
  entityName: string;
  groups: string[];
}

export type NodeKind =
  | 'target' // анализируемый кошелёк
  | 'tracked' // кошелёк из списка, с которым найдена связь
  | 'intermediary' // посредник на пути к отслеживаемому кошельку
  | 'funder' // звено цепочки финансирования (без найденной связи со списком)
  | 'hub' // биржа / сервис / инфраструктура, дальше не раскрывается
  | 'sibling' // вероятно, другой кошелёк того же владельца (не из списка)
  | 'pair' // второй кошелёк в режиме «Два кошелька»
  | 'other'; // прочий заметный контрагент, для полноты карты

/**
 * Почему адрес считается хабом.
 * cex — биржа из меток; service — биржа или сервис, распознанный по поведению (раздаёт SOL сотням кошельков);
 * collector — кошелёк комиссий (только принимает от многих); rewards — раздача наград держателям токена (пачки мелких
 * выплат многим одним и тем же адресам); program, jito, fee, system, burn — инфраструктура.
 */
export type HubCategory = 'cex' | 'service' | 'collector' | 'rewards' | 'program' | 'jito' | 'fee' | 'system' | 'burn';

export interface GraphNode {
  /** Адрес кошелька. */
  id: string;
  kind: NodeKind;
  /** Имя из списка, метка хаба или сокращённый адрес. */
  label: string;
  emoji?: string;
  /** Только для tracked. */
  entity?: string;
  entityName?: string;
  groups?: string[];
  /** Метка известного адреса: «Binance 2», «Jito tip» и т. п. */
  hubLabel?: string;
  /** Только для hub. */
  hubCategory?: HubCategory;
  /**
   * Адрес похож на личный депозитный адрес на бирже: всё полученное пересылает на кошелёк биржи.
   * Значение — имя биржи или «биржа». Общий депозитный адрес у двух кошельков — сильный признак одного владельца.
   */
  depositOf?: string;
  /** Расстояние от цели в рёбрах: 0 — цель. */
  hop: number;
  /** Сила связи с целью, 0..1. Для tracked и sibling. */
  score?: number;
  /** Суммарный объём SOL на рёбрах узла, задаёт размер пузыря. */
  volumeSol: number;
  /** Число разных кошельков-контрагентов, если известно. */
  degree?: number;
  /** Только в карте группы: номер кластера выбранного кошелька. */
  cluster?: number;
}

export interface TransferRecord {
  signature: string;
  /** Unix-секунды; null, если время неизвестно. */
  blockTime: number | null;
  slot: number;
  from: string;
  to: string;
  /** Mint токена; для SOL — So11111111111111111111111111111111111111111. */
  mint: string;
  /** «SOL», «USDC» или сокращённый mint. */
  symbol: string;
  /** Количество в человекочитаемых единицах. */
  amount: number;
  /** Это не перевод между двумя кошельками ребра, а покупка токена одним из них — доказательство совместной покупки (GraphEdge.coBuy). */
  coBuy?: true;
}

export interface GraphEdge {
  /** `${source}|${target}`, адреса отсортированы лексикографически. */
  id: string;
  source: string;
  target: string;
  /** SOL, ушедший source → target. */
  solForward: number;
  /** SOL, ушедший target → source. */
  solBackward: number;
  /** Переводы не-SOL токенов в обе стороны. */
  tokenTransferCount: number;
  transferCount: number;
  firstTime: number | null;
  lastTime: number | null;
  /** Ребро — первое пополнение одного из кошельков. Значение: адрес профинансированного кошелька. */
  fundingOf?: string;
  /** Сила ребра 0..1. */
  strength: number;
  /**
   * Кошельки покупали одни и те же токены в одном и том же слоте, разными транзакциями (типично для бандлов одного владельца).
   * Ребро может состоять только из этого: тогда transferCount = 0, а transfers содержит покупки обоих (coBuy: true).
   */
  coBuy?: { mints: number; slots: number };
  /**
   * Один кошелёк ребра оплачивал комиссии за транзакции другого (был fee payer): так делают со своими кошельками.
   * payer — адрес плательщика (source или target ребра), txCount — сколько транзакций из проверенной выборки.
   * Ребро может состоять только из этого: тогда transferCount = 0.
   */
  feesPaid?: { payer: string; txCount: number };
  /** Переводы, новые сверху; не более 200. */
  transfers: TransferRecord[];
}

export type ConnectionType =
  | 'direct' // прямые переводы между целью и отслеживаемым
  | 'common-funder' // один кошелёк пополнял и цель, и отслеживаемый
  | 'common-recipient' // оба отправляли одному кошельку
  | 'shared-deposit' // оба отправляли на один и тот же депозитный адрес биржи
  | 'co-buy' // покупали одни и те же токены в одном слоте (бандл одного владельца)
  | 'fee-payer' // один платил комиссии за транзакции другого, или у обоих общий плательщик комиссий
  | 'via-intermediary' // связь через посредника, смешанные направления
  | 'funding-chain'; // отслеживаемый стоит выше в цепочке финансирования цели

/** Один путь от цели к отслеживаемому кошельку. */
export interface ConnectionPath {
  type: ConnectionType;
  /** Адреса от цели до отслеживаемого включительно. */
  nodes: string[];
  /** Идентификаторы рёбер вдоль пути. */
  edgeIds: string[];
  score: number;
  /** Объяснение на русском, одно предложение. */
  reason: string;
}

/** Все найденные связи с одним отслеживаемым кошельком. */
export interface Connection {
  wallet: TrackedWallet;
  /** Итоговая сила связи 0..1 по всем путям. */
  score: number;
  /** Минимальное число рёбер до цели. */
  hops: number;
  /** Пути по убыванию score. */
  paths: ConnectionPath[];
  totalSol: number;
  transferCount: number;
  firstTime: number | null;
  lastTime: number | null;
}

/** Связи, сгруппированные по сущности (все кошельки «Cupsey» и т. п.). */
export interface EntityConnection {
  entity: string;
  entityName: string;
  emoji: string;
  score: number;
  /** Адреса отслеживаемых кошельков этой сущности, с которыми есть связь. */
  wallets: string[];
}

/** Признаки того, что кошелёк принадлежит тому же владельцу, что и цель. */
export type SiblingSignal =
  | 'funded-by-target' // цель — первый источник SOL этого кошелька
  | 'funded-target' // этот кошелёк — первый источник SOL цели
  | 'common-funder' // у обоих один и тот же первый источник SOL (не биржа)
  | 'two-way' // заметные переводы SOL в обе стороны
  | 'token-moves' // между ними перемещались токены (типично для бандлов)
  | 'shared-deposit' // оба пополняли один депозитный адрес биржи
  | 'co-buy' // покупали одни и те же токены в одном слоте
  | 'fee-payer'; // один платил комиссии за транзакции другого, или общий плательщик комиссий

/** Кошелёк не из списка, который, вероятно, принадлежит тому же человеку, что и цель. */
export interface SiblingCandidate {
  address: string;
  /** 0..1. */
  score: number;
  signals: SiblingSignal[];
  /** Объяснения по признакам, на русском, по одному предложению. */
  reasons: string[];
  /** Рёбра карты, на которых основан вывод. */
  edgeIds: string[];
  /** SOL между целью и кандидатом в обе стороны (0, если прямых переводов нет). */
  totalSol: number;
  transferCount: number;
}

export type Depth = 1 | 2 | 3;

export interface AnalyzeOptions {
  /** 1 — только прямые связи; 2 — плюс через одного посредника; 3 — плюс пути в три шага и цепочка финансирования до 4 уровней. По умолчанию 2. */
  depth?: Depth;
  /** Сколько последних переводов цели загружать. По умолчанию 2000. */
  maxTransfers?: number;
  /** Переводы SOL меньше этой суммы не создают связей (пыль, спам). По умолчанию 0.01. */
  minSol?: number;
  /** Сколько посредников раскрывать. По умолчанию 12. */
  maxIntermediaries?: number;
  /** Игнорировать кэш и загрузить историю заново. */
  refresh?: boolean;
}

export interface AnalyzeStats {
  provider: string;
  transfersLoaded: number;
  walletsFetched: number;
  apiCalls: number;
  /** Оценка израсходованных кредитов Helius; 0 для публичного RPC. */
  creditsEstimate: number;
  durationMs: number;
  /** История цели загружена не полностью (упёрлись в лимит). */
  truncated: boolean;
}

export interface AnalyzeResult {
  target: string;
  /** Цель сама есть в списке отслеживания. */
  targetTracked: TrackedWallet | null;
  generatedAt: number;
  options: Required<AnalyzeOptions>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** По убыванию score. */
  connections: Connection[];
  /** По убыванию score. */
  entities: EntityConnection[];
  /** Вероятные другие кошельки владельца цели (не из списка), по убыванию score. Пусто при глубине 1. */
  siblings: SiblingCandidate[];
  /** Предупреждения для пользователя, на русском. */
  warnings: string[];
  stats: AnalyzeStats;
}

// ---------- Режим «Два кошелька» ----------

export interface LinkOptions {
  /** Наибольшая длина пути в рёбрах: 2 — через одного посредника, 3–4 — через цепочку. По умолчанию 3. */
  maxHops?: 2 | 3 | 4;
  minSol?: number;
  refresh?: boolean;
}

/** Один путь от a к b. */
export interface LinkPath {
  /** direct, common-funder, common-recipient, shared-deposit, via-intermediary или funding-chain (общий источник выше по цепочкам). */
  type: ConnectionType;
  /** Адреса от a до b включительно. */
  nodes: string[];
  edgeIds: string[];
  score: number;
  reason: string;
}

export interface LinkResult {
  a: string;
  b: string;
  aTracked: TrackedWallet | null;
  bTracked: TrackedWallet | null;
  generatedAt: number;
  options: Required<LinkOptions>;
  /** Итоговая сила связи 0..1 по лучшим путям. */
  score: number;
  /** По убыванию score, не более 15. */
  paths: LinkPath[];
  /** a — kind 'target', b — kind 'pair'; hop — расстояние от a. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  stats: AnalyzeStats;
}

// ---------- Вкладка «Кошельки» ----------

/** Строка таблицы кошельков списка. */
export interface WalletRow extends TrackedWallet {
  /** Баланс SOL; null — не загружен или не удалось получить. */
  balanceSol: number | null;
  /** Последний известный перевод (unix-секунды) по кэшу; null — данных нет. Точность зависит от свежести индекса. */
  lastActive: number | null;
  /** Самый ранний известный перевод — возраст кошелька; null, если ранняя история не загружена. */
  firstSeen: number | null;
  /** Что есть в кэше: история переводов, плательщики комиссий; когда история обновлялась. */
  indexed: { history: boolean; payers: boolean; fetchedAt: number | null };
}

/** GET /api/wallets */
export interface WalletsResponse {
  wallets: WalletRow[];
  /** Когда загружены балансы (unix-мс); null — не загружались. */
  balancesAt: number | null;
}

/** POST /api/wallets/refresh — тело { address }: точная последняя активность одним запросом. */
export interface WalletRefreshRequest {
  address: string;
}

// ---------- Карта выбранных кошельков ----------

export interface GroupOptions {
  /** false — только по кэшу, без запросов к сети (быстро, ≈0 кредитов); true — догрузить истории и проверить пары по всей истории. */
  deep?: boolean;
  minSol?: number;
}

/** POST /api/group — до 15 адресов; ответ: AnalyzeStartResponse, дальше опрос /api/jobs/:id (kind 'group'). */
export interface GroupRequest extends GroupOptions {
  addresses: string[];
}

/** Связь между двумя выбранными кошельками (лучший путь). */
export interface GroupLink {
  a: string;
  b: string;
  type: ConnectionType;
  score: number;
  reason: string;
  /** Узлы от a до b включительно. */
  nodes: string[];
  edgeIds: string[];
}

export interface GroupResult {
  addresses: string[];
  generatedAt: number;
  options: Required<GroupOptions>;
  /** По убыванию score; для каждой пары — до 3 путей. */
  links: GroupLink[];
  /** Группы выбранных кошельков, связанных между собой (score ≥ 0.5), по убыванию размера; одиночки — отдельными группами. */
  clusters: string[][];
  /** Связи выбранных с другими кошельками списка (не выбранными), по убыванию score, не более 40. */
  external: Array<{ from: string; wallet: TrackedWallet; type: ConnectionType; score: number; reason: string }>;
  /** Выбранные — kind 'target' с полем cluster (номер в clusters); посредники, хабы, внешние кошельки списка. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  stats: AnalyzeStats;
}

// ---------- Поиск бандла ----------
//
// Кошельки, которые покупают и продают те же токены, что и цель, в те же минуты (бандл одного владельца, бот на многих кошельках).
// Источник: история пула каждого токена (контрагент цели в её сделке: бондинг-кривая, пул) в окне вокруг сделки цели,
// поэтому видны все покупатели, не только кошельки из списка.

export interface BundleOptions {
  /** Сколько последних купленных цель токенов проверять: 3–30. По умолчанию 10. */
  tokens?: number;
  /** Окно вокруг сделки цели в минутах: ±windowMin. По умолчанию 5. */
  windowMin?: 1 | 3 | 5 | 10 | 30;
  /** Учитывать продажи: совместный выход из токена (отдельное окно вокруг продажи цели). По умолчанию true. */
  sells?: boolean;
  /**
   * Максимальный поиск: у сильных кандидатов проверяются первые пополнения и собственные покупки (отличает бандл от копитрейдеров),
   * плюс второй круг по токенам самых сильных — находит кошельки бандла, торговавшие без цели. Дороже: +300–1500 кредитов.
   */
  expand?: boolean;
  refresh?: boolean;
}

/** Наибольшее число страниц истории пула (по 100 переводов, 10 кредитов) на одно окно. */
// BUNDLE_MAX_PAGES = 20 — оценка стоимости до запуска: от tokens × (sells ? 2 : 1) × 10 до tokens × (sells ? 2 : 1) × 200 кредитов.

/** POST /api/bundle — ответ: AnalyzeStartResponse, дальше опрос /api/jobs/:id (kind 'bundle'). */
export interface BundleRequest extends BundleOptions {
  address: string;
}

/**
 * Признаки бандла.
 * same-tx — купили в одной транзакции (одна транзакция на несколько кошельков — инструмент бандлера);
 * same-slot — в том же слоте (≈0.4 с); near — в пределах 30 секунд; window — в пределах окна;
 * co-sell — совместные продажи; transfers — прямые переводы SOL или токенов с целью;
 * common-funder — общий первый источник SOL с целью или с другим найденным кошельком; funded-by-target — цель первой пополнила кошелёк (или наоборот);
 * overlap — кошелёк покупает в основном те же токены, что и цель;
 * copytrader — похоже на копитрейдера: стабильно заходит через несколько секунд после цели и больше ничем не связан (это предупреждение, оценку снижает).
 */
export type BundleSignal = 'same-tx' | 'same-slot' | 'near' | 'window' | 'co-sell' | 'transfers' | 'common-funder' | 'funded-by-target' | 'overlap' | 'copytrader';

/** Один проверенный токен. */
export interface BundleToken {
  mint: string;
  /** Сокращённый mint (названия токенов не загружаются). */
  symbol: string;
  /** Чья сделка задаёт окна: цель или кошелёк первого круга (при expand). */
  seed: string;
  /** Адрес, чья история читалась (контрагент сделки seed: бондинг-кривая, пул); null — не найден. */
  pool: string | null;
  buySlot: number | null;
  buyTime: number | null;
  buySignature: string | null;
  sellSlot: number | null;
  sellTime: number | null;
  sellSignature: string | null;
  /** Сколько других кошельков торговали этим токеном в окнах (толпа: чем больше, тем слабее каждое совпадение). */
  crowd: number;
  /** Сколько найденных кошельков совпали в этом токене. */
  matched: number;
  /** Сколько переводов пула прочитано. */
  transfersScanned: number;
  /** Окно прочитано не полностью (упёрлись в предел страниц). */
  truncated: boolean;
  /** Почему токен пропущен (общий адрес площадки, нет пула, ошибка); null — проверен. */
  skipped: string | null;
}

/** Одно совпадение кандидата со сделкой seed. */
export interface BundleMatch {
  mint: string;
  kind: 'buy' | 'sell';
  seed: string;
  signal: 'same-tx' | 'same-slot' | 'near' | 'window';
  /** Время сделки кандидата минус время сделки seed, секунды (минус — раньше seed); null — время неизвестно. */
  dtSec: number | null;
  slotDelta: number;
  /** Транзакция кандидата. */
  signature: string;
  seedSignature: string;
  time: number | null;
  /** SOL, потраченный (покупка) или полученный (продажа) кандидатом в этой сделке, если виден в истории пула. */
  sol: number | null;
  /** Вклад в оценку 0..1. */
  weight: number;
}

export interface BundleWallet {
  address: string;
  /** 0..1. */
  score: number;
  /** Разных токенов с совпадениями. */
  tokensMatched: number;
  signals: BundleSignal[];
  /** Объяснения на русском, по одному предложению. */
  reasons: string[];
  /** По убыванию weight, не более 40. */
  matches: BundleMatch[];
  tracked: TrackedWallet | null;
  /** Найден во втором круге — адрес кошелька первого круга, через которого найден; null — найден по сделкам цели. */
  via: string | null;
  /** Прямые переводы с целью по загруженной истории цели (SOL в обе стороны и число переводов, включая токены). */
  totalSol: number;
  transferCount: number;
  /** Первый источник SOL (только при expand, иначе null). */
  firstFunder: string | null;
  /** Доля купленных кошельком токенов, которые покупала и цель, 0..1 (только при expand, иначе null). */
  overlap: number | null;
  /** Похоже на копитрейдера (см. BundleSignal 'copytrader'). */
  copytrader: boolean;
}

export interface BundleResult {
  target: string;
  targetTracked: TrackedWallet | null;
  generatedAt: number;
  options: Required<BundleOptions>;
  /** Сначала токены цели (новые сверху), затем токены второго круга. */
  tokens: BundleToken[];
  /** По убыванию score, не более 60. */
  wallets: BundleWallet[];
  /** Сколько кошельков отброшено: bots — десятки сделок по одному токену (боты, роутеры); sandwich — покупка и продажа за пару секунд; programs — аккаунты программ. */
  excluded: { bots: number; sandwich: number; programs: number };
  warnings: string[];
  stats: AnalyzeStats & { tokensScanned: number; transfersScanned: number };
}

// Оценка стоимости «глубокой» карты группы из n кошельков для показа до запуска: n·(n−1)/2 × 10 + n × 70 + 200 (проверка посредников) кредитов.

// ---------- HTTP API ----------

/** GET /api/status */
export interface StatusResponse {
  provider: string;
  providerNote: string;
  hasHeliusKey: boolean;
  trackedCount: number;
  entityCount: number;
  /** Сколько отслеживаемых кошельков уже проиндексировано в кэше. */
  indexedCount: number;
}

/** GET /api/tracked */
export interface TrackedResponse {
  wallets: TrackedWallet[];
}

/** POST /api/tracked/import — тело: JSON-экспорт Axiom (массив объектов с trackedWalletAddress). */
export interface ImportResponse {
  imported: number;
  entityCount: number;
}

/** POST /api/analyze — тело: AnalyzeRequest. */
export interface AnalyzeRequest extends AnalyzeOptions {
  address: string;
}
export interface AnalyzeStartResponse {
  jobId: string;
}

/** POST /api/link — тело: LinkRequest; ответ: AnalyzeStartResponse, дальше опрос /api/jobs/:id. */
export interface LinkRequest extends LinkOptions {
  a: string;
  b: string;
}

/** GET /api/jobs/:id */
export interface JobResponse {
  id: string;
  status: 'running' | 'done' | 'error';
  /** Сообщения о ходе работы, по порядку. */
  progress: string[];
  kind: 'analyze' | 'link' | 'group' | 'bundle';
  /** Для kind = 'analyze'. */
  result?: AnalyzeResult;
  /** Для kind = 'link'. */
  link?: LinkResult;
  /** Для kind = 'group'. */
  group?: GroupResult;
  /** Для kind = 'bundle'. */
  bundle?: BundleResult;
  error?: string;
}

/** Ошибка любого эндпоинта: HTTP 4xx/5xx с телом { error: string }. */
export interface ErrorResponse {
  error: string;
}
