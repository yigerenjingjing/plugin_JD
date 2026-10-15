/**
 * 采集核心：商品列表提取、商品详情提取、评论滚动采集。
 *
 * 逻辑移植自源项目：
 *   - 商品卡片提取  crawler/jd_product_extractor.py
 *   - 评论采集      crawler/jd_comment_crawler.py
 *
 * 差异说明：源项目每个字段都用「多选择器逐个尝试」，这里保留同样策略；
 * 源项目用 DrissionPage 的 page.eles()，这里改用标准的 querySelectorAll。
 */

// 用 var 而不是 const：多个内容脚本文件共享同一个全局作用域，
// 重复声明 const 会抛 "Identifier 'JD' has already been declared"。
var JD = (globalThis.JD = globalThis.JD || {});

// ══════════════════════════════════════════════════════════
// 1. 搜索结果页：商品卡片提取
// ══════════════════════════════════════════════════════════

/**
 * 从商品卡片提取详情页链接。
 * 优先用 data-sku 拼链接，失败再找卡片内的商品链接。
 * 对应 jd_product_extractor.sku_link / first_link。
 */
JD._cardLink = function (card) {
  const own = card.getAttribute && card.getAttribute('data-sku');
  if (own && /^\d+$/.test(own)) {
    return `https://item.jd.com/${own}.html`;
  }

  const inner = card.querySelector('[data-sku]');
  if (inner) {
    const sku = inner.getAttribute('data-sku');
    if (sku && /^\d+$/.test(sku)) {
      return `https://item.jd.com/${sku}.html`;
    }
  }

  for (const selector of ['a[href*="item.jd.com"]', 'a[href*="//item.jd.com"]']) {
    for (const a of card.querySelectorAll(selector)) {
      const link = JD.normalizeUrl(a.getAttribute('href'));
      if (link) return link;
    }
  }
  return '';
};

/**
 * 按商品卡片逐行提取，避免不同字段列表错位。
 * 对应 jd_product_extractor.extract_products_by_cards。
 */
JD.extractProductsByCards = function (limit) {
  const S = JD.SELECTORS;

  for (const cardSelector of S.CARD) {
    let cards = [];
    try {
      cards = Array.from(document.querySelectorAll(cardSelector));
    } catch (e) {
      cards = [];
    }
    if (!cards.length) continue;

    const products = [];
    for (const card of cards) {
      const name = JD.pickText(card, S.NAME);
      const priceText = JD.pickText(card, S.PRICE);
      // 名称和价格缺一不可，否则说明这一层选择器命中的不是商品卡片
      if (!name || !priceText) continue;

      const salesText = JD.pickText(card, S.SALES).replace(/\//g, '');

      products.push({
        商品名称: name.replace(/\//g, ''),
        价格: priceText.replace(/\//g, ''),
        活动: JD.pickText(card, S.PROMOTION),
        店铺名称: JD.pickText(card, S.STORE).replace(/\//g, ''),
        销量: salesText,
        详情链接: JD._cardLink(card)
      });

      if (products.length >= limit) break;
    }

    if (products.length) return products;
  }
  return [];
};

/**
 * 提取当前搜索结果页的商品列表。
 * 对应 jd_product_extractor.extract_product_list，保留风控页检测。
 */
JD.extractProductList = function (limit) {
  if (JD.looksLikeVerification()) {
    throw new Error('检测到京东风控或验证页面，请在浏览器中手动完成验证后重试。');
  }

  const products = JD.extractProductsByCards(limit);
  if (!products.length) {
    throw new Error(
      '没有提取到商品。可能原因：页面还没加载完、出现验证码，或京东页面结构变化需要更新选择器。'
    );
  }
  return products;
};

/** 粗略判断当前是否处于京东风控/验证码页面。对应 jd_product_extractor._looks_like_verification。 */
JD.looksLikeVerification = function () {
  const url = (location.href || '').toLowerCase();
  if (/(captcha|verify|safe\.jd\.com|security)/.test(url)) return true;

  const markers = ['安全验证', '滑动验证', '请完成验证'];
  const bodyText = (document.body && document.body.innerText) || '';
  for (const marker of markers) {
    if (bodyText.includes(marker)) return true;
  }
  return false;
};

// ══════════════════════════════════════════════════════════
// 2. 商品详情页：字段提取
// ══════════════════════════════════════════════════════════

/**
 * 按标签找价格。
 *
 * 不能直接用 textNearLabel：那个函数在标签自身那一层就返回了，
 * 拿到的会是「到手价」这三个字。价格一般和标签在同一个父容器里，
 * 所以这里逐层向上，直到某层的文字里出现货币金额。
 */
JD.findPriceNearLabel = function (labels) {
  for (const label of labels) {
    const el = JD.findSmallestByText(label);
    if (!el) continue;

    let node = el;
    for (let up = 0; up < 5 && node; up++) {
      const text = (node.innerText || node.textContent || '').trim();
      const m = text.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
      if (m) return `¥${m[1]}`;
      node = node.parentElement;
    }
  }
  return '';
};

/** 判断取到的文字是否像店铺名，避免把导航项、按钮文字当成店铺。 */
JD.isPlausibleStore = function (name) {
  const t = String(name || '').trim();
  if (t.length < 2 || t.length > 40) return false;
  // 这些是页面上的固定文字，不是店铺名
  if (/^(店铺|卖家|关注店铺|联系客服|进店逛逛|店铺详情|京东自营)$/.test(t)) return false;
  if (t.includes('关注') || t.includes('客服')) return false;
  return true;
};

/** 找店铺名：优先店铺主页链接，其次类名，最后才按标签猜并做校验。 */
JD.findStore = function () {
  const S = JD.SELECTORS;

  // 1. 店铺主页链接最可靠
  for (const a of document.querySelectorAll('a[href*="mall.jd.com"], a[href*="//mall.jd.com"]')) {
    const t = (a.innerText || a.textContent || '').trim();
    if (JD.isPlausibleStore(t)) return t;
  }

  // 2. 类名选择器
  for (const selector of S.DETAIL_STORE) {
    try {
      const el = document.querySelector(selector);
      if (!el) continue;
      const t = (el.innerText || el.textContent || '').trim().replace(/\//g, '');
      if (JD.isPlausibleStore(t)) return t;
    } catch (e) {
      // 忽略非法选择器
    }
  }

  // 3. 标签兜底，必须通过合理性校验
  const near = JD.textNearLabel(S.LABEL_STORE, 4);
  if (near) {
    const candidate = near.text.replace(/^(店铺|卖家)[：:]\s*/, '').trim();
    if (JD.isPlausibleStore(candidate) && candidate !== near.label) return candidate;
  }

  return '';
};

/**
 * 导出某个锚点附近的 DOM 结构，用于确认真实类名。
 *
 * 只在诊断时调用。返回每个子树节点的标签、类名和文字长度，
 * 这样不必打开开发者工具就能看出评论卡片用的是哪个类。
 */
JD.dumpArea = function (anchorText, opts = {}) {
  const maxDepth = opts.maxDepth || 3;
  const maxNodes = opts.maxNodes || 30;
  const minLen = opts.minLen || 4;

  const anchor = JD.findSmallestByText(anchorText);
  if (!anchor) return { found: false, anchor: anchorText };

  // 从锚点向上找到第一个「有多个子元素」的容器，那通常是列表容器
  let container = anchor;
  for (let i = 0; i < 8 && container.parentElement; i++) {
    container = container.parentElement;
    if (container.children.length >= 3) break;
  }

  const nodes = [];
  const walk = (el, depth) => {
    if (depth > maxDepth || nodes.length >= maxNodes) return;
    for (const child of el.children) {
      if (nodes.length >= maxNodes) return;
      const text = (child.textContent || '').trim();
      if (text.length < minLen) continue;
      const cls = typeof child.className === 'string' ? child.className : '';
      nodes.push({
        d: depth,
        tag: child.tagName.toLowerCase(),
        cls: cls.slice(0, 110),
        n: text.length,
        text: text.slice(0, 45)
      });
      walk(child, depth + 1);
    }
  };
  walk(container, 0);

  return {
    found: true,
    anchor: anchorText,
    container: {
      tag: container.tagName.toLowerCase(),
      cls: (typeof container.className === 'string' ? container.className : '').slice(0, 110),
      children: container.children.length
    },
    nodes
  };
};

/**
 * 从商品详情页提取名称、价格、店铺、销量。
 *
 * 策略是「文字标签优先，CSS 选择器兜底」：
 * 京东改版会换掉所有哈希类名，但「到手价」「累计评价」这些中文标签很少变。
 * 先按标签定位，取不到才退回类名选择器。
 */
JD.extractProductDetail = function () {
  const S = JD.SELECTORS;

  // ── 商品名称 ──
  let name = JD.pickText(document, S.DETAIL_NAME);
  if (!name && document.title) {
    // 详情页标题通常形如「【xxx】商品名 - 京东」
    name = document.title.replace(/【[^】]*】/g, '').split('-')[0].trim();
  }

  // ── 价格 ──
  let price = JD.pickText(document, S.DETAIL_PRICE).replace(/\//g, '');
  if (!price) {
    price = JD.findPriceNearLabel(S.LABEL_PRICE);
  }

  // ── 评价数 / 销量 ──
  let sales = JD.pickText(document, S.DETAIL_SALES).replace(/\//g, '');
  if (!sales) {
    const near = JD.textNearLabel(S.LABEL_SALES, 4);
    if (near) {
      // 「累计评价 1万+」这类文案，截出数值部分
      const m = near.text.match(/[\d.]+\s*万?\+?/);
      if (m) sales = m[0].trim();
    }
  }

  // ── 店铺 ──
  // 店铺名容易取错（导航项、按钮文字都含「店铺」），所以统一走 findStore，
  // 它带合理性校验，取不准时返回空字符串而不是错的值。
  const store = JD.findStore();

  return {
    商品名称: String(name || '').replace(/\//g, ''),
    价格: price,
    活动: '',
    店铺名称: store,
    销量: sales,
    详情链接: JD.normalizeUrl(location.href),
    销量解析: JD.parseSalesNum(sales),
    好评率: JD.parseGoodRate(sales)
  };
};


/**
 * 列出页面上所有「确实可滚动」的容器，并标出哪个里面装着评论。
 *
 * 这是定位「评论区为什么不滚动」最直接的手段：如果评论在某个浮层里，
 * 这里会看到那个浮层的滚动容器；如果列表在页面流里，
 * 就不会有带评论的可滚动容器（说明该滚 window）。
 */
JD.dumpScrollable = function (limit = 15) {
  const out = [];

  for (const el of document.querySelectorAll('div, ul, section, main, aside')) {
    if (out.length >= limit) break;
    if (!JD.isVisible(el)) continue;

    let style;
    try {
      style = getComputedStyle(el);
    } catch (e) {
      continue;
    }

    const oy = style.overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    if (el.scrollHeight <= el.clientHeight + 10) continue;
    // 太矮的多半是下拉框、标签栏之类，不是评论容器
    if (el.clientHeight < 80) continue;

    const cls = typeof el.className === 'string' ? el.className : '';
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: cls.slice(0, 90),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      // 关键字段：这个滚动容器里到底有没有评论。
      // 新旧两版评论正文的类名都要认，只认旧版会漏掉新版列表。
      hasComments: Boolean(
        el.querySelector(
          '.jdc-pc-rate-card-main-desc, .comment-con, [class*="rate-card-main-desc"], ' +
            'ul.list li, .comment-root li, li.item'
        )
      )
    });
  }

  return out;
};

/** 导出指定选择器第一个匹配元素的子树结构，用于确认卡片内部布局。 */
JD.dumpSelector = function (selector, opts = {}) {
  const maxDepth = opts.maxDepth || 3;
  const maxNodes = opts.maxNodes || 20;
  const minLen = opts.minLen || 1;

  let el;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    return { found: false, selector, error: '非法选择器' };
  }
  if (!el) return { found: false, selector };

  const nodes = [];
  const walk = (node, depth) => {
    if (depth > maxDepth || nodes.length >= maxNodes) return;
    for (const child of node.children) {
      if (nodes.length >= maxNodes) return;
      const text = (child.textContent || '').trim();
      if (text.length < minLen) continue;
      const cls = typeof child.className === 'string' ? child.className : '';
      nodes.push({
        d: depth,
        tag: child.tagName.toLowerCase(),
        cls: cls.slice(0, 110),
        n: text.length,
        text: text.slice(0, 60)
      });
      walk(child, depth + 1);
    }
  };
  walk(el, 0);

  let count = 0;
  try {
    count = document.querySelectorAll(selector).length;
  } catch (e) {
    count = 0;
  }

  return {
    found: true,
    selector,
    count,
    root: {
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 110)
    },
    // innerText 带换行，用来核对按行抽取正文的规则是否合适
    innerText: (el.innerText || '').slice(0, 200),
    nodes
  };
};

/**
 * 页面诊断：先激活评论区，再报告选择器命中情况和真实 DOM 结构。
 *
 * 必须在滚动之后才探测评论，否则页面上根本没有评论节点，
 * 所有评论选择器都会是 0，看起来像选择器写错了，其实是还没加载。
 */
JD.diagnose = async function (options = {}) {
  const S = JD.SELECTORS;
  const deep = options.deep !== false;

  // 先把评论区点开并滚出来，这样下面的探测才有意义
  const sectionFound = await JD.scrollToCommentArea();

  const probe = (selectors, limit = 3) => {
    for (const sel of selectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      if (els.length) {
        return {
          selector: sel,
          count: els.length,
          samples: Array.from(els)
            .slice(0, limit)
            .map((e) => JD.extractText(e).slice(0, 100))
        };
      }
    }
    return null;
  };

  const result = {
    url: location.href,
    pageType: JD.detectPageType(),
    title: document.title,
    commentSectionFound: sectionFound,
    extracted: JD.extractProductDetail(),
    matched: {
      名称: probe(S.DETAIL_NAME),
      价格: probe(S.DETAIL_PRICE),
      店铺: probe(S.DETAIL_STORE),
      销量: probe(S.DETAIL_SALES),
      评论文本: probe(S.COMMENT_TEXT, 5),
      评论条目: probe(S.COMMENT_ITEM, 3)
    },
    labels: {
      销量: JD.textNearLabel(S.LABEL_SALES, 4),
      价格: JD.textNearLabel(S.LABEL_PRICE, 4),
      评论区: JD.textNearLabel(S.LABEL_COMMENT_AREA, 3)
    },
    // 滚动目标：确认滚的是评论浮层还是背后的商品页
    滚动目标: JD.describeCommentScrollTarget(),
    // 页面上所有可滚动容器，用来找出评论所在的滚动层
    可滚动容器: JD.dumpScrollable()
  };

  // 深度模式才导出 DOM 结构，输出比较长
  if (deep) {
    result.structure = {
      评论条目: JD.dumpSelector('.comment-root ul.list > li', { maxDepth: 2, maxNodes: 18 }),
      店铺区: JD.dumpArea('关注店铺', { maxDepth: 2, maxNodes: 16 }),
      价格区: JD.dumpArea('到手价', { maxDepth: 2, maxNodes: 12 })
    };

    // 实机验证一次抽取效果，能看到抽出来的正文长什么样
    result.sampleExtraction = (() => {
      const sel = JD.visibleCommentItemSelector();
      if (!sel) return null;
      const items = Array.from(document.querySelectorAll(sel)).slice(0, 5);
      return items.map((el) => ({
        raw: (el.innerText || '').replace(/\n/g, ' / ').slice(0, 120),
        extracted: JD.extractCommentText(el).slice(0, 80)
      }));
    })();
  }

  return result;
};

// ══════════════════════════════════════════════════════════
// 3. 评论采集
// ══════════════════════════════════════════════════════════

/** 返回当前页面可用的评论文本选择器。对应 jd_comment_crawler.visible_comment_selector。 */
JD.visibleCommentSelector = function () {
  for (const selector of JD.SELECTORS.COMMENT_TEXT) {
    try {
      if (document.querySelector(selector)) return selector;
    } catch (e) {
      // 忽略非法选择器
    }
  }
  return '';
};

/** 返回当前页面可用的评论条目选择器（命中整个卡片，需要再抽正文）。 */
JD.visibleCommentItemSelector = function () {
  for (const selector of JD.SELECTORS.COMMENT_ITEM) {
    try {
      const els = document.querySelectorAll(selector);
      // 至少两条才算列表，单条可能是页面上的其他 ul
      if (els.length >= 2) return selector;
    } catch (e) {
      // 忽略非法选择器
    }
  }
  return '';
};

/**
 * 从一条评论卡片里抽出正文。
 *
 * 新版评论卡片的 innerText 形如：
 *     j***i
 *     狗狗磨牙耐咬咀嚼玩具... 拖鞋+胡萝卜+单耳球
 *     狗子超喜欢，玩了很久也不坏
 *     2025-09-12
 * 直接取全文会把用户名和商品规格也当成评论内容，所以按行过滤：
 * 丢掉用户名（短且只含字母数字和掩码符号）、日期、以及商品规格行。
 */
JD.extractCommentText = function (el) {
  const raw = (el.innerText || el.textContent || '').trim();
  if (!raw) return '';

  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length <= 1) return raw.replace(/\s+/g, ' ');

  const kept = [];
  for (const line of lines) {
    if (/^\d{4}[-/年]\d{1,2}/.test(line)) continue;              // 日期
    if (/^[a-zA-Z0-9*_\-]{1,16}$/.test(line)) continue;          // 用户名，如 j***i
    if (/^(已购买|购买过|规格|颜色|尺码)[：:]/.test(line)) continue; // 规格前缀
    kept.push(line);
  }

  if (!kept.length) return raw.replace(/\s+/g, ' ');

  // 正文通常是保留下来最长的一行
  let best = '';
  for (const line of kept) {
    if (line.length > best.length) best = line;
  }
  return best;
};

/** 找到评论列表的容器，用于把滚动限制在评论区范围内。 */
JD.findCommentContainer = function () {
  const candidates = [
    '.comment-root',
    '[class*="comment-root"]',
    '[class*="commentRoot"]',
    'ul.list'
  ];
  for (const sel of candidates) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (e) {
      // 忽略非法选择器
    }
  }
  return null;
};

/**
 * 从一个元素往上找最近的可滚动祖先。
 *
 * 点击「全部评价」后评论区通常是个独立浮层，自己带滚动条，
 * overflow 不是 visible。滚 window 只会带动背后的商品页，
 * 浮层纹丝不动，所以必须找到浮层内部的滚动容器来滚。
 */
JD.findScrollableAncestor = function (el) {
  let node = el;
  for (let depth = 0; depth < 20 && node && node !== document.body; depth++) {
    try {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          node.scrollHeight > node.clientHeight + 10) {
        return node;
      }
    } catch (e) {
      // 忽略
    }
    node = node.parentElement;
  }
  return null;
};

/**
 * 返回应该滚动的元素，没有可滚动容器时返回 null（表示滚页面）。
 *
 * 判定标准是「哪个元素确实能滚」，不是「哪个元素看起来像评论区」。
 * 早先的写法是取第一个可见评论条目不往上找可滚动祖先就返回，
 * 结果选中了单条 `li`（高度固定、不可滚动），`humanScroll` 判定不可滚动
 * 又改回滚 window，于是出现「评论区不动、商品页在滚」。
 *
 * 另外点开「全部评价」后 DOM 里会同时存在预览区和浮层两份评论，
 * 两者都能通过可见性检查（浮层是覆盖上去的，没有隐藏预览区），
 * 所以只能靠「内部是否真有滚动条」来区分，选能滚的那个。
 */
JD.getCommentScrollTarget = function () {
  const candidates = [];
  const pushVisible = (selector) => {
    try {
      for (const el of document.querySelectorAll(selector)) {
        if (JD.isVisible(el)) candidates.push(el);
      }
    } catch (e) {
      // 忽略非法选择器
    }
  };

  // 按精确度从高到低收集候选。
  // 评论文本节点最可靠：它一定在评论列表内部，
  // 从它往上找可滚动祖先，不用猜容器叫什么名字。
  for (const sel of JD.SELECTORS.COMMENT_TEXT) pushVisible(sel);

  const itemSel = JD.visibleCommentItemSelector();
  if (itemSel) pushVisible(itemSel);

  for (const sel of JD.SELECTORS.COMMENT_CONTAINER) pushVisible(sel);

  for (const el of candidates) {
    const scrollable = JD.findScrollableAncestor(el);
    if (scrollable) return scrollable;
    // 容器自身可滚动（没有更上层的滚动祖先）
    if (el.scrollHeight > el.clientHeight + 10) return el;
  }

  return null;
};

/** 描述滚动目标，用于日志，确认到底滚的是哪个元素。 */
JD.describeCommentScrollTarget = function () {
  const el = JD.getCommentScrollTarget();

  if (!el) {
    return { mode: 'page', note: '没有可滚动的评论容器，将滚动页面' };
  }

  return {
    mode: 'container',
    tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
    scrollable: el.scrollHeight > el.clientHeight + 10,
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight
  };
};

/**
 * 在评论区范围内滚动一步。
 *
 * 这里刻意**不做** `window.scrollTo({top: document.body.scrollHeight})`。
 * 那会直接跳到页面最底部，而页面下方还有「为你推荐」「达人选购」等板块，
 * 跳到底部等于离开了评论区，后续读取自然拿不到新内容，
 * 白做一次无意义的下拉。
 *
 * 改成：评论容器自身可滚动就滚容器；否则按固定像素步进滚动页面，
 * 始终停在评论区附近。
 */
JD.humanScroll = async function (container) {
  const L = JD.LIMITS;
  const steps = JD.randInt(L.SCROLL_STEP_MIN, L.SCROLL_STEP_MAX);
  const canScroll =
    container && container.scrollHeight > container.clientHeight + 10;

  for (let i = 0; i < steps; i++) {
    if (canScroll) {
      // 滚容器时按可视高度的比例滚，而不是固定像素。
      // 评论容器实测只有 649px 高，固定滚 200-600px 推不动加载；
      // 按半屏到一个屏来滚，既够触发懒加载，也接近真人翻页的幅度。
      const lo = Math.max(150, Math.round(container.clientHeight * 0.5));
      const hi = Math.max(lo + 50, Math.round(container.clientHeight * 0.9));
      container.scrollTop += JD.randInt(lo, hi);
    } else {
      window.scrollBy({
        top: JD.randInt(L.SCROLL_PIXEL_MIN, L.SCROLL_PIXEL_MAX),
        behavior: 'smooth'
      });
    }
    await JD.sleep(JD.randInt(200, 500));
  }

  await JD.sleep(JD.randInt(L.COMMENT_SCROLL_DELAY_MIN, L.COMMENT_SCROLL_DELAY_MAX));
};

/**
 * 把视口拉到评论区，之后的滚动都从这一带开始。
 *
 * 评论区是**懒渲染**的：不滚到它附近，页面上连 `ul.list` 和
 * 「全部评价」按钮都不存在。所以不能直接用 scrollIntoView 定位
 * （元素还没被创建），要按步进往下滚，边滚边找。
 */
JD.scrollToCommentArea = async function () {
  const findAnchor = () =>
    JD.getCommentScrollTarget() ||
    JD.findCommentContainer() ||
    JD.findSmallestByText('买家评价');

  for (let i = 0; i < 14; i++) {
    const anchor = findAnchor();
    if (anchor) {
      try {
        anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (e) {
        anchor.scrollIntoView();
      }
      await JD.sleep(800);
      return true;
    }
    window.scrollBy({ top: 600, behavior: 'smooth' });
    await JD.sleep(350);
  }
  return false;
};

/**
 * 滚动评论页并收集评论。
 * 对应 jd_comment_crawler.collect_comments：
 *   - 先清洗再计入有效配额，无效文本不占名额
 *   - 文本去重且保留首次出现的页面顺序
 *   - 连续多轮没有新增有效评论就停止
 *
 * @param {number} max 目标评论条数
 * @param {(count:number)=>void} [onProgress] 每轮收集后的回调
 * @returns {Promise<string[]>}
 */
JD.collectComments = async function (max, onProgress) {
  const L = JD.LIMITS;

  // 采集过程的遥测，回给后台写日志。
  // 评论条数不对时，看这个就知道是「没找到选择器」「滚动没生效」
  // 还是「滚了但页面不加载」——不用再猜参数。
  const stats = {
    mode: null,
    selector: null,
    rounds: 0,
    counts: [],
    scrollTarget: null,
    scrollTopStart: null,
    scrollTopEnd: null,
    error: null
  };
  JD.lastCollectStats = stats;

  if (max <= 0) return [];

  // 两种读取方式：优先精确的正文选择器；找不到就退到「条目」选择器，
  // 从整张卡片里抽正文。
  const pickMode = () => {
    const textSel = JD.visibleCommentSelector();
    if (textSel) return { mode: 'text', selector: textSel };

    const itemSel = JD.visibleCommentItemSelector();
    if (itemSel) return { mode: 'item', selector: itemSel };

    return null;
  };

  let target = pickMode();

  // 评论区可能还在渲染，等一下再判定。
  if (!target) {
    for (let i = 0; i < 3 && !target; i++) {
      await JD.sleep(800);
      target = pickMode();
    }
  }
  if (!target) {
    stats.error = '未找到评论选择器';
    throw new Error('未找到可用的评论选择器，页面结构可能已变化。');
  }

  stats.mode = target.mode;
  stats.selector = target.selector;

  // 定位滚动目标。不是 window：点开「全部评价」后评论区往往是独立浮层，
  // 有自己的滚动条，滚 window 只会带动背后的商品页。
  let scrollTarget = JD.getCommentScrollTarget();
  if (scrollTarget) {
    try {
      scrollTarget.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) {
      scrollTarget.scrollIntoView();
    }
    await JD.sleep(800);
    stats.scrollTopStart = Math.round(scrollTarget.scrollTop);
    stats.scrollTarget =
      `${scrollTarget.tagName.toLowerCase()}.` +
      `${(typeof scrollTarget.className === 'string' ? scrollTarget.className : '').slice(0, 60)}`;
    stats.scrollHeight = scrollTarget.scrollHeight;
    stats.clientHeight = scrollTarget.clientHeight;
  }

  const readOne = (el) =>
    target.mode === 'text' ? JD.extractText(el) : JD.extractCommentText(el);

  const comments = [];
  const seen = new Set();
  let retries = L.SCROLL_RETRIES;

  while (retries > 0) {
    stats.rounds += 1;

    const els = document.querySelectorAll(target.selector);
    const before = comments.length;

    for (const el of els) {
      for (const text of JD.cleanComments([readOne(el)])) {
        if (!seen.has(text)) {
          seen.add(text);
          comments.push(text);
        }
        if (comments.length >= max) {
          stats.counts.push(comments.length);
          if (scrollTarget) stats.scrollTopEnd = Math.round(scrollTarget.scrollTop);
          if (onProgress) onProgress(comments.length);
          return comments;
        }
      }
    }

    stats.counts.push(comments.length);

    if (comments.length > before) {
      retries = L.SCROLL_RETRIES;
    } else {
      retries -= 1;
    }

    if (onProgress) onProgress(comments.length);
    if (retries <= 0) break;

    // 每轮重新确认滚动目标：懒加载和浮层都可能改变 DOM 结构
    scrollTarget = JD.getCommentScrollTarget() || scrollTarget;
    await JD.humanScroll(scrollTarget);

    if (scrollTarget) stats.scrollTopEnd = Math.round(scrollTarget.scrollTop);
  }

  return comments;
};

/**
 * 点击「全部评价」展开完整评论区。
 *
 * 新版详情页的评论区是固定高度的预览，只显示前几条，**滚动不会加载更多**，
 * 必须点这个入口才能看到完整列表。这是滚动采集拿不到 10 条的原因。
 *
 * 返回 { found, clicked, href }
 *   - href 有值：入口是链接，交给后台导航，避免 content script 被销毁后失联
 *   - clicked=true：已点击，可能是原地展开，也可能是 JS 跳转
 *
 * 刻意不在这里 await：如果点击触发了页面跳转，content script 会被销毁，
 * 这个函数根本执行不完。所以同步点击后立刻返回，由后台对比 URL 判断结果。
 */
JD.expandAllComments = function () {
  const btn = JD.pickMixed(document, JD.SELECTORS.ALL_COMMENT_BUTTON);
  if (!btn) return { found: false, clicked: false };

  const anchor = btn.closest('a[href]');
  if (anchor && /^https?:/.test(anchor.href || '')) {
    const href = anchor.href;
    // 指向商品页自身的锚点链接不算，那种点击只是页内滚动
    if (href.split('#')[0] !== location.href.split('#')[0]) {
      return { found: true, clicked: false, href };
    }
  }

  try {
    (btn.closest('button, div, a') || btn).click();
  } catch (e) {
    return { found: true, clicked: false, error: String((e && e.message) || e) };
  }
  return { found: true, clicked: true };
};

/** 等待页面主体渲染完成，用于导航之后的稳定等待。 */
JD.waitPageReady = async function (timeout = JD.LIMITS.PAGE_READY_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (document.readyState === 'complete' && document.body) return true;
    await JD.sleep(200);
  }
  return false;
};
