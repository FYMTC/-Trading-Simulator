import { ForumPost, NewsItem, EmotionState } from '../../../shared/types';
import { uid } from '../config';

// ============================================================
//  论坛用户 / 帖子模板 / 新闻模板
//  从 v0.2 单文件 index.html (1701-1829行) 迁移
// ============================================================

interface ForumUser {
  name: string;
  avatar: string;
  color: string;
}

interface NewsTemplate {
  tag: 'info' | 'hot' | 'warn';
  text: string;
}

/** 论坛用户(10个) */
const FORUM_USERS: ForumUser[] = [
  { name: '股海老船长', avatar: '7B', color: '#58a6ff' },
  { name: '韭菜花', avatar: '9C', color: '#f85149' },
  { name: '价值投资客', avatar: 'JZ', color: '#3fb950' },
  { name: '短线追涨杀跌', avatar: 'DX', color: '#d29922' },
  { name: '量化矿工', avatar: 'LH', color: '#db6d28' },
  { name: '吃瓜散户', avatar: 'CG', color: '#8b949e' },
  { name: '满仓踏空', avatar: 'MC', color: '#f85149' },
  { name: '清仓观望', avatar: 'QC', color: '#6e7681' },
  { name: '波段高手', avatar: 'BD', color: '#58a6ff' },
  { name: '缩量反弹', avatar: 'SL', color: '#3fb950' },
];

/** 看涨模板(8条) */
const FORUM_TEMPLATES_BULL: string[] = [
  '放量突破{price}！这波看涨到{target}！',
  '主力资金进场了，{name}要起飞',
  '今天分时图走得不错，尾盘大概率拉升',
  '量价齐升，持仓不动',
  '突破前高，新一轮上涨开启',
  '北向资金净流入，看好{name}后续走势',
  '这个位置企稳了，逢低加仓',
  'macd金叉，短线看涨',
];

/** 看跌模板(8条) */
const FORUM_TEMPLATES_BEAR: string[] = [
  '跌破{price}了，要不要止损？',
  '主力在出货吧，分时图太难看',
  '缩量下跌，感觉还要跌',
  '割肉了，亏了{pct}%，再也不玩了',
  '这票废了，没有资金关注',
  '大盘跳水，{name}跟着跌',
  '反弹无力，减仓保平安',
  '死叉了，短线还有下跌空间',
];

/** 中性模板(8条) */
const FORUM_TEMPLATES_NEUTRAL: string[] = [
  '今天震荡，观望为主',
  '{name}横盘好久了，等方向选择',
  '量能萎缩，变盘在即',
  '这个位置可上可下，控制仓位',
  '做T为主，不留过夜仓',
  '等放量再说，现在没量',
  '缩量整理，耐心等待',
  '技术面看不出方向，再看看',
];

/** 新闻模板(10条) */
const NEWS_TEMPLATES: NewsTemplate[] = [
  { tag: 'info', text: '{name}发布季度财报，营收同比增长{pct}%' },
  { tag: 'hot', text: '{name}获机构买入评级，目标价{price}元' },
  { tag: 'info', text: '北向资金今日净流入{amount}亿元' },
  { tag: 'warn', text: '央行公开市场操作，释放流动性{amount}亿' },
  { tag: 'info', text: '{name}股东大会通过分红方案，每股派{price}元' },
  { tag: 'hot', text: '某券商研报：{name}处于行业领先地位' },
  { tag: 'warn', text: '美联储议息会议临近，市场观望情绪浓厚' },
  { tag: 'info', text: '{name}新增产能投产，预计贡献年收入{amount}亿' },
  { tag: 'hot', text: '板块异动：科技板块集体拉升，{name}领涨' },
  { tag: 'warn', text: '市场成交量突破{amount}亿，情绪高涨' },
];

/** 情绪溢出-贪婪新闻模板 */
const EMOTION_NEWS_BULL: string[] = [
  '{group}情绪极度亢奋，{name}遭遇资金抢筹',
  '市场进入狂热状态，{group}疯狂追涨{name}',
  '{group}资金大举入场，{name}放量飙升',
  '贪婪情绪蔓延，{group}集体看多{name}',
];

/** 情绪溢出-恐惧新闻模板 */
const EMOTION_NEWS_BEAR: string[] = [
  '{group}恐慌性抛售，{name}放量下挫',
  '市场情绪崩塌，{group}集体出逃{name}',
  '{group}资金大举撤离，{name}承压下行',
  '恐慌情绪蔓延，{group}争相减仓{name}',
];

/** 从数组中随机取一个元素 */
function randPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
//  ForumNewsSystem
// ============================================================

/**
 * 舆情系统
 * 负责生成论坛帖子与新闻，并汇总市场情绪分数
 */
export class ForumNewsSystem {
  forumPosts: ForumPost[];
  newsItems: NewsItem[];
  maxItems: number;

  constructor() {
    this.forumPosts = [];
    this.newsItems = [];
    this.maxItems = 50;
  }

  /**
   * 生成一条论坛帖子
   * @param currentPrice   当前价格
   * @param priceChange    当前涨跌幅(如 0.012 表示 +1.2%)
   * @param instrumentName 标的名称
   */
  generateForumPost(currentPrice: number, priceChange: number, instrumentName: string): ForumPost {
    const user = randPick(FORUM_USERS);
    let template: string;
    let sentiment: ForumPost['sentiment'];

    if (priceChange > 0.005) {
      template = randPick(FORUM_TEMPLATES_BULL);
      sentiment = 'bullish';
    } else if (priceChange < -0.005) {
      template = randPick(FORUM_TEMPLATES_BEAR);
      sentiment = 'bearish';
    } else {
      template = randPick(FORUM_TEMPLATES_NEUTRAL);
      sentiment = 'neutral';
    }

    const target = (currentPrice * (1.05 + Math.random() * 0.1)).toFixed(2);
    const pct = (Math.random() * 20 + 5).toFixed(1);
    const text = template
      .replace('{price}', currentPrice.toFixed(2))
      .replace('{target}', target)
      .replace('{name}', instrumentName)
      .replace('{pct}', pct);

    const post: ForumPost = {
      author: user.name,
      avatar: user.avatar,
      color: user.color,
      content: text,
      sentiment,
      time: Date.now(),
    };
    this.forumPosts.unshift(post);
    if (this.forumPosts.length > this.maxItems) this.forumPosts.pop();
    return post;
  }

  /**
   * 生成一条新闻
   * @param currentPrice   当前价格
   * @param instrumentName 标的名称
   */
  generateNews(currentPrice: number, instrumentName: string): NewsItem {
    const template = randPick(NEWS_TEMPLATES);
    const amount = Math.floor(10 + Math.random() * 90);
    const price = (currentPrice * (0.8 + Math.random() * 0.4)).toFixed(2);
    const pct = (Math.random() * 40 - 5).toFixed(1);
    const text = template.text
      .replace('{name}', instrumentName)
      .replace('{price}', price)
      .replace('{pct}', pct)
      .replace('{amount}', amount.toString());

    const news: NewsItem = {
      id: uid(),
      tag: template.tag,
      text,
      time: Date.now(),
      sentiment: this.sentimentForTag(template.tag),
    };
    this.newsItems.unshift(news);
    if (this.newsItems.length > this.maxItems) this.newsItems.pop();
    return news;
  }

  /**
   * 计算近 10 条论坛帖子的市场情绪分数
   * bullish +1, bearish -1, neutral 0，再除以帖子数
   * @returns [-1, 1] 区间的情绪分数
   */
  getMarketSentiment(): number {
    if (this.forumPosts.length === 0) return 0;
    let score = 0;
    const recent = this.forumPosts.slice(0, 10);
    for (const p of recent) {
      if (p.sentiment === 'bullish') score += 1;
      else if (p.sentiment === 'bearish') score -= 1;
    }
    return score / recent.length;
  }

  /** 清空论坛帖子与新闻 */
  clear(): void {
    this.forumPosts = [];
    this.newsItems = [];
  }

  /**
   * 当某组情绪溢出(|emotion| > 0.8)时生成情绪驱动新闻
   * @param emotion        三组情绪状态
   * @param instrumentName 标的名称
   * @returns 新闻条目；无需生成时返回 null
   */
  generateEmotionNews(emotion: EmotionState, instrumentName: string): NewsItem | null {
    const groups: Array<{ label: string; value: number }> = [
      { label: '散户', value: emotion.retail },
      { label: '大户', value: emotion.whale },
      { label: '机构', value: emotion.institution },
    ];

    // 选择绝对值最大且超过阈值(0.8)的组
    let overflow: { label: string; value: number } | null = null;
    let maxAbs = 0.8;
    for (const g of groups) {
      const abs = Math.abs(g.value);
      if (abs > maxAbs) {
        maxAbs = abs;
        overflow = g;
      }
    }

    if (!overflow) return null;

    const isGreed = overflow.value > 0;
    const template = randPick(isGreed ? EMOTION_NEWS_BULL : EMOTION_NEWS_BEAR);
    const text = template
      .replace('{name}', instrumentName)
      .replace('{group}', overflow.label);

    const sentiment = isGreed
      ? 0.5 + Math.random() * 0.4   // 0.5 ~ 0.9
      : -0.5 - Math.random() * 0.4; // -0.9 ~ -0.5

    const news: NewsItem = {
      id: uid(),
      tag: isGreed ? 'hot' : 'warn',
      text,
      time: Date.now(),
      sentiment,
    };
    this.newsItems.unshift(news);
    if (this.newsItems.length > this.maxItems) this.newsItems.pop();
    return news;
  }

  /** 根据 tag 生成新闻情绪值 */
  private sentimentForTag(tag: 'info' | 'hot' | 'warn'): number {
    switch (tag) {
      case 'hot':
        return 0.3 + Math.random() * 0.5;   // 0.3 ~ 0.8
      case 'warn':
        return -0.3 - Math.random() * 0.5;  // -0.8 ~ -0.3
      case 'info':
      default:
        return Math.random() * 0.5 - 0.2;   // -0.2 ~ 0.3
    }
  }
}
