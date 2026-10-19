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
    // 「到手价」标签如果位于推荐卡 cross_platform_card 里就跳过，
    // 那是其他商品的价，不是本商品
    if (el.closest && el.closest('[class*="cross_platform_card"]')) continue;

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
  // 兜底选择器 [class*="price_"] 可能命到推荐卡 cross_platform_card，
  // 命中了就丢掉重来，靠 findPriceNearLabel 在非推荐卡区域找
  if (price) {
    const el = JD.pick(document, S.DETAIL_PRICE);
    if (el && el.closest && el.closest('[class*="cross_platform_card"]')) {
      price = '';
    }
  }
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

  // 好评率优先从销量文案解析（旧版汇总里常是「累计评价 1万+ 好评率98%」），
  // 新版模板分开放了，销量文案不含好评率，要从独立元素读
  let goodRate = JD.parseGoodRate(sales);
  if (!goodRate) {
    const rateText = JD.pickText(document, S.DETAIL_GOOD_RATE);
    if (rateText) goodRate = JD.parseGoodRate(rateText);
  }

  return {
    商品名称: String(name || '').replace(/\//g, ''),
    价格: price,
    活动: '',
    店铺名称: store,
    销量: sales,
    详情链接: JD.normalizeUrl(location.href),
    销量解析: JD.parseSalesNum(sales),
    好评率: goodRate
  };
};

/**
 * 读取参数表中的一行，返回 { key, value }，认不到返回 null。
 *
 * 京东的参数表有多种结构，按常见程度逐个认：
 *   - dl 行：<dd class="Ptable-tit">参数名</dd><dd>参数值</dd>，或 dt + dd
 *   - 表格行：th / td
 *   - li 卡片：title 属性或文字形如「品牌：胡姬花」
 */
JD.readParamPair = function (row) {
  const keyEl = row.querySelector('dd.Ptable-tit, dt, th, td[class*="tit"], td[class*="name"]');
  if (keyEl) {
    const valEl = keyEl.nextElementSibling;
    if (valEl) {
      return { key: JD.extractText(keyEl), value: JD.extractText(valEl) };
    }
  }

  // 新版模板实测结构：一行是 div.item，里面 div.label > div.text 是参数名，
  // 同行的其他子元素是参数值。用「label 元素」识别键，值取剩下的子元素。
  const labelEl = row.querySelector('div.label, [class*=" label"], [class*="_label"]');
  // label 必须是行的直接子元素：querySelector 会穿过包装层匹配到深层 label，
  // 那样会把整行文字当成「值」，键值错乱。
  if (labelEl && labelEl.parentElement === row) {
    const key = JD.extractText(labelEl).replace(/\s+/g, '').trim();
    for (const other of Array.from(row.children)) {
      if (other === labelEl) continue;
      const value = JD.extractText(other).replace(/\s+/g, ' ').trim();
      if (value && value !== key && key && key.length <= 20) {
        return { key, value };
      }
    }
  }

  // 新模板常见的「一行两个元素」：第一个是参数名，第二个是参数值
  if (row.children.length >= 2) {
    const kids = Array.from(row.children).filter((c) => {
      const t = JD.extractText(c).replace(/\s+/g, '');
      return t && t.length <= 80;
    });
    if (kids.length === 2) {
      const key = JD.extractText(kids[0]).replace(/\s+/g, '').trim();
      const value = JD.extractText(kids[1]).replace(/\s+/g, ' ').trim();
      if (
        key && value && key !== value && key.length <= 12 &&
        /[一-龥]/.test(key) && !/[*＊?？]/.test(key) &&
        /[一-龥\d]/.test(value)
      ) {
        return { key, value };
      }
    }
  }

  // li 卡片：优先 title 属性（京东通常在 title 里放完整「参数名：参数值」），
  // 没有 title 就匹配整行文字。
  const title = (row.getAttribute && row.getAttribute('title')) || '';
  const text = JD.extractText(row);
  for (const raw of [title, text]) {
    const m = String(raw || '').match(/^([^：:。]{1,24})[：:]\s*(.+)$/);
    if (m) return { key: m[1], value: m[2] };
  }
  return null;
};

/**
 * 锚点兜底：不依赖任何类名，按「参数名文字」定位参数值。
 *
 * 新模板的类名是 React CSS-module 哈希串（实测如 _scoped_1iut5_2），
 * 类名选择器永远追不上。但这些没被哈希化的中文文字几乎只在参数区出现：
 * 「品牌」「商品编号」「保质期」——找到后读它所在行/后一个兄弟元素，
 * 就能还原键值。只认固定锚点列表，无法覆盖全部参数名，
 * 但能把用户要的核心字段拿到，结构认出来之前先保证数据不漏。
 */
JD.parseProductParamsAnchored = function () {
  const params = {};

  const add = (key, value) => {
    const k = String(key || '').replace(/\s+/g, '').trim();
    let v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!k || !v || v.length > 120) return;
    // 值里带着重复的参数名（如「品牌：力士」剥成「力士」）
    v = v.replace(/^[：:]\s*/, '').trim();
    if (params[k] === undefined) params[k] = v;
  };

  const anchorNames = [
    '品牌', '商品编号', '保质期', '生产许可证', '执行标准', '净含量',
    '货号', '原产地', '是否进口', '配料表', '主要成分', '包装清单'
  ];

  for (const name of anchorNames) {
    if (params[name] !== undefined) continue;

    const keyEl = JD.findSmallestByText(name);
    if (!keyEl) continue;

    // 跳过脚本、模板这类非渲染节点：XPath 的 contains(text()) 会匹配
    // <script> 内嵌 JSON（页面常把参数也塞一份进去），那里没有可配对的 DOM 值
    if (keyEl.closest && keyEl.closest('script, style, noscript, template')) continue;

    // 元素自身文字可能是更长、更准确的参数名（锚点「保质期」，文字「保质期类别」）
    const own = (keyEl.innerText || keyEl.textContent || '')
      .replace(/\s+/g, '')
      .trim();
    const keyName =
      own.length >= 2 && own.length <= 14 && !/[：:].*/.test(own)
        ? own
        : name;

    // ① 锚点自身就带「参数名：参数值」（顶部汇总 li 常见）
    const m = own.match(/^([^：:]{1,14})[：:](.*)$/);
    if (m) {
      add(m[1], m[2]);
      continue;
    }

    // ② 值在下一个兄弟元素里（新版常见两个并列的 key/value 元素）
    let value = '';
    let sib = keyEl.nextElementSibling;
    while (sib) {
      const t = JD.extractText(sib).replace(/\s+/g, ' ').trim();
      if (t && t !== keyName) {
        value = t;
        break;
      }
      sib = sib.nextElementSibling;
    }

    if (!value) {
      // ③ 向上找「这一行」，把行文本里的参数名剥掉。
      // 行文本必须比键名长才停——否则会停在只装了键名的 label 层
      // （长度 2 的「品牌」标签恰好满足旧判断的 >=2），剥完就空了。
      let row = keyEl;
      for (let up = 0; up < 5 && row.parentElement; up++) {
        row = row.parentElement;
        const t = (row.innerText || row.textContent || '').trim();
        if (t.length > keyName.length && t.length <= 120) break;
      }
      value = (row.innerText || '').trim()
        .replace(new RegExp('^\\s*' + keyName), '')
        .replace(/^[：:]\s*/, '')
        .trim();
    }

    add(keyName, value);
  }

  return params;
};

/**
 * 解析当前页面的商品详情参数表，返回「参数名 → 参数值」的对象。
 *
 * 同一字段可能在顶部汇总和下面的规格与包装表里各列一遍，
 * 这里只保留第一个非空读数，避免重复字段互相覆盖。
 */
JD.parseProductParams = function () {
  const params = {};

  const add = (key, value) => {
    const k = String(key || '').replace(/\s+/g, '').trim();
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!k || !v) return;
    // 不做关键词过滤：「包装清单」「规格」这类词本身可能是真实参数名，
    // 分组标题是 <h3>，行选择器不会选中它，靠结构排除就够了。
    if (params[k] === undefined) params[k] = v;
  };

  for (const selector of JD.SELECTORS.DETAIL_PARAM_ITEM) {
    let rows = [];
    try {
      rows = Array.from(document.querySelectorAll(selector));
    } catch (e) {
      rows = [];
    }
    if (!rows.length) continue;

    let used = 0;
    for (const row of rows) {
      const pair = JD.readParamPair(row);
      if (pair) {
        add(pair.key, pair.value);
        used += 1;
      }
    }
    // 这一层已经吃到成对的参数，说明结构认对了；再往后的通用选择器
    // 只会重复读同一批数据，没必要跑到最通用的那层。
    if (used >= 2) break;
  }

  // 结构认不出（或认不全）时，用锚点法补齐：
  // 「品牌 / 商品编号 / 保质期」这些字几乎只在参数区出现，不受改版影响。
  // 锚点已覆盖的键不再覆盖，结构化解析的结果优先保留。
  const anchored = JD.parseProductParamsAnchored();
  for (const k of Object.keys(anchored)) {
    if (params[k] === undefined) params[k] = anchored[k];
  }

  // 动态补齐：参数详情块里扫所有「键：值」行。
  // 商品特有字段（型号、香型、适用人群等）每个商品都不同，
  // 没有固定词表，只能按行的结构特征扫，键名任意。
  const dynamic = JD.parseProductParamsDynamic();
  for (const k of Object.keys(dynamic)) {
    if (params[k] === undefined) params[k] = dynamic[k];
  }

  return params;
};

/**
 * 动态提取参数区：不依赖类名、不依赖固定键名。
 *
 * 思路：先定位参数区所在的「详情块」（从「规格参数 / 商品详情」标签
 * 文字向上爬，找到子元素较多的容器，新版模板把标签和内容面板装在一起），
 * 再在块内扫所有 div / li / dl / tr，凡符合「键：值」行的就收下。
 * 这样型号、香型这类商品特有字段也能拿到；块外面（评论区、推荐位）的行
 * 不会被扫进去，避免误收。
 */
JD.parseProductParamsDynamic = function () {
  const params = {};

  // 0. 定位参数区所在的大容器。
  //    优先从参数内容（品牌 / 商品编号 / 保质期…）向上爬到参数列表容器
  //    （实测 div.list，子元素 >=3）：从内容内部爬，直接就落在参数区上。
  //    爬不到再退回按「规格参数 / 商品详情」标签文字向上找详情块（>=5）。
  const findBlock = (labels, minChildren) => {
    for (const label of labels) {
      const el = JD.findSmallestByText(label);
      if (!el) continue;
      let b = el;
      for (let up = 0; up < 8 && b.parentElement; up++) {
        if (b.children.length >= minChildren) break;
        b = b.parentElement;
      }
      if (b.children.length >= minChildren) return b;
    }
    return null;
  };

  let block = findBlock(['品牌', '商品编号', '保质期', '净含量', '货号', '生产许可证'], 3);
  if (!block) block = findBlock(['规格参数', '商品详情', '售后保障'], 5);
  if (!block || block === document.body || block === document.documentElement) {
    return params;
  }

  const UI_WORDS = new Set([
    '商品详情', '规格参数', '售后保障', '商品评价', '买家评价',
    '全部评价', '相关分类', '联系客服', '加入购物车', '立即购买',
    '关注店铺', '进店逛逛', '品牌专区'
  ]);

  let rows = [];
  try {
    rows = Array.from(block.querySelectorAll('div, li, dl, tr'));
  } catch (e) {
    rows = [];
  }

  // 性能保护：详情块再大也只扫到一定量为止
  const SCAN_LIMIT = 8000;

  for (let i = 0; i < rows.length && i < SCAN_LIMIT; i++) {
    const row = rows[i];
    if (row.closest && row.closest('script, style, noscript, template')) continue;

    // 快速过滤：大部分节点不是行——要么有一对子元素，要么本身是短文本
    const t = (row.textContent || '');
    if (t.length > 120 && row.children.length < 2) continue;

    const pair = JD.readParamPair(row);
    if (!pair) continue;

    const key = pair.key.replace(/\s+/g, '').trim();
    if (!key || UI_WORDS.has(key)) continue;
    if (params[key] !== undefined) continue;
    params[key] = pair.value;
  }

  return params;
};

/**
 * 导出某个「参数名」文字在页面里的上下文链（向上各层标签、类名、文字），
 * 以及它旁边有没有能配对的兄弟值。诊断时用来确认参数区到底在哪一层、
 * 文字以什么形式出现（真实的键值行、脚本里的 JSON、还是裸标签）。
 */
JD.probeParamAnchor = function (label) {
  const el = JD.findSmallestByText(label);
  if (!el) return { label, found: false };

  const chain = [];
  let node = el;
  for (let up = 0; up < 6 && node; up++) {
    chain.push({
      d: up,
      tag: node.tagName.toLowerCase(),
      cls: (typeof node.className === 'string' ? node.className : '').slice(0, 70),
      n: (node.textContent || '').length,
      own: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').slice(0, 40)
    });
    if (!node.parentElement) break;
    node = node.parentElement;
  }

  const sibling = el.nextElementSibling;
  return {
    label,
    found: true,
    own: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').slice(0, 30),
    siblingValue: sibling
      ? (sibling.innerText || sibling.textContent || '').replace(/\s+/g, ' ').slice(0, 30)
      : '',
    chain
  };
};

/**
 * 价格探测：列出页面上所有「叶子金额元素」及其父层上下文。
 *
 * 新版模板的推荐卡（cross_platform_card）也带 ¥xxx，和商品真实价格
 * 混在一起。这里只收「自身文本含金额、且子元素都不含金额」的叶子元素，
 * 避免一层一层重复上报同一个价格；再补上父层的类名和文字，
 * 一眼看出哪个价格属于商品本身、哪个属于推荐位。
 */
JD.probePrices = function (limit = 10) {
  const out = [];
  const isPrice = (el) => /[¥￥]\s*\d/.test((el.textContent || '').trim());

  const collect = (el) => {
    for (const c of el.children) {
      if (out.length >= limit) return;
      if (isPrice(c)) {
        const childHasPrice = Array.from(c.children).some((k) => isPrice(k));
        if (!childHasPrice) {
          const parent = c.parentElement;
          out.push({
            tag: c.tagName.toLowerCase(),
            cls: (typeof c.className === 'string' ? c.className : '').slice(0, 60),
            text: (c.textContent || '').trim().slice(0, 30),
            parentCls: parent
              ? (typeof parent.className === 'string' ? parent.className : '').slice(0, 60)
              : '',
            parentText: parent ? (parent.textContent || '').trim().slice(0, 40) : ''
          });
        }
      }
      collect(c);
    }
  };

  try {
    collect(document.body || document.documentElement);
  } catch (e) {
    // 忽略，返回已收集的
  }
  return out;
};

/**
 * 店铺探测：列出店铺名可能存在的几处位置。
 * 实测新版页面店铺名在 div.top-shop-info > div.top-name-tag > div.top-name
 * （「联合利华京东自营旗舰店」），旧版选择器认不到。
 */
JD.probeStore = function () {
  const text = (el) => (el ? (el.textContent || '').trim().slice(0, 30) : '');

  const mallLinks = Array.from(
    document.querySelectorAll('a[href*="mall.jd.com"]')
  )
    .slice(0, 5)
    .map((a) => text(a));

  const named = Array.from(
    document.querySelectorAll(
      '[class*="top-name"], .shopName, [class*="shopName"], [class*="shop-name"]'
    )
  )
    .slice(0, 6)
    .map((e) => ({
      cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60),
      text: text(e)
    }));

  return {
    mallLinks,
    named,
    label: JD.textNearLabel(['店铺', '卖家', '自营'], 4)
  };
};

/**
 * 好评率探测：列出页面上所有「短文本 + 百分比 + 好评相关词」的位置。
 * 新版页面的好评率文案可能有多种写法（好评率 94% / 94%好评 / 超94%买家赞不绝口），
 * 先看到真实文案，再决定 parseGoodRate 的扩展正则。
 */
JD.probeGoodRate = function (limit = 12) {
  const out = [];
  const isGoodRate = (el) => {
    const t = (el.textContent || '').trim();
    if (t.length < 4 || t.length > 60) return false;
    if (!/(好评|赞不绝口|支持率|满意)/.test(t)) return false;
    return /(\d+(?:\.\d+)?)\s*%|%\s*(\d+(?:\.\d+)?)/.test(t);
  };

  const collect = (el) => {
    for (const c of el.children) {
      if (out.length >= limit) return;
      if (isGoodRate(c)) {
        const childAlso = Array.from(c.children).some((k) => isGoodRate(k));
        if (!childAlso) {
          out.push({
            tag: c.tagName.toLowerCase(),
            cls: (typeof c.className === 'string' ? c.className : '').slice(0, 60),
            text: (c.textContent || '').trim().slice(0, 40)
          });
        }
      }
      collect(c);
    }
  };

  try {
    collect(document.body || document.documentElement);
  } catch (e) {
    // 忽略
  }
  return out;
};

/**
 * 款式区组名推测：从容器的标题元素、前一个兄弟元素、或选项文字
 * 的共性推测这个组是什么属性（颜色/尺码/规格/版本…）。
 */
JD._guessVariantGroupName = function (container) {
  // 1. 容器自身的标题子元素
  const titleEl = container.querySelector(
    'dt, h3, h4, [class*="title"], [class*="label"], [class*="tit"], [class*="name"]'
  );
  if (titleEl) {
    const t = JD.extractText(titleEl).replace(/[：:]/g, '').trim();
    if (t && t.length <= 10) return t;
  }

  // 2. 容器前一个兄弟（标签常在选项组左边）
  let prev = container.previousElementSibling;
  for (let i = 0; i < 3 && prev; i++) {
    const t = JD.extractText(prev).replace(/[：:]/g, '').trim();
    if (t && t.length <= 10 && t.length >= 1) return t;
    prev = prev.previousElementSibling;
  }

  // 3. 选项文字的共性推测（都带「支/盒/瓶」是规格，都带「红/蓝」是颜色）
  const items = Array.from(container.children)
    .map((c) => (c.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  if (items.length) {
    if (items.some((t) => /[支片盒包个袋瓶罐升克千mlg]/.test(t))) return '规格';
    if (items.some((t) => /[红蓝绿黑白灰金粉紫银]/.test(t))) return '颜色';
  }

  // 4. 容器自身的类名提示
  var contCls = typeof container.className === 'string' ? container.className : '';
  if (/spec/i.test(contCls)) return '款式';

  return '款式';
};

/** 在元素自身的文字或子元素里找货币金额。 */
JD._findPriceInElement = function (el) {
  const own = (el.textContent || '').trim();
  const m = own.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (m) return '¥' + m[1];
  // 子元素里可能有独立的 price 标签
  const priceEl = el.querySelector('[class*="price"], [class*="Price"]');
  if (priceEl) {
    const pm = (priceEl.textContent || '').trim().match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
    if (pm) return '¥' + pm[1];
  }
  return '';
};

/** 从 className + getComputedStyle 推测库存状态。 */
JD._guessStockStatus = function (el) {
  var cls = typeof el.className === 'string' ? el.className : '';
  if (/disable|item-disable|item_disable|sold-out|sold_out|out-of-stock|out_of_stock|lack/.test(cls)) {
    return '无货';
  }
  if (el.hasAttribute && el.hasAttribute('disabled')) return '无货';
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return '无货';
  try {
    var style = getComputedStyle(el);
    var opacity = parseFloat(style.opacity);
    if (opacity > 0 && opacity < 0.6) return '无货';
    var color = style.color || '';
    if (/rgb\(\s*153\s*,\s*153\s*,\s*153/.test(color) ||
        /rgb\(\s*(20[0-4])\s*,\s*(20[0-4])\s*,\s*(20[0-4])/.test(color)) {
      return '无货';
    }
  } catch (e) {}
  return '有货';
};

/** 选项是否被选中：class 含 selected/active/current/checked。
 * 切忌用短词如 on/cur——suffix 里的 ion/spec 就会误命中。 */
JD._isSelected = function (el) {
  var cls = typeof el.className === 'string' ? el.className : '';
  return /(--sel|--selected|--active|--current|--checked)(\b|_|-)/i.test(cls);
};

/**
 * 款式探测：列出页面上所有款式/变体选项元素及其结构。
 *
 * 不点击选项，只读 DOM。重点：
 *   1. 带 data-sku 的元素（最可靠的变体标识）
 *   2. 类名特征容器（choose-wrap / sku-choose 等）
 *   3. 重复子结构的容器（通用变体模式）
 */
JD.probeVariants = function (limit) {
  limit = limit || 20;
  var out = [];

  // 1. data-sku 元素探测
  var dataSkuEls = [];
  try { dataSkuEls = Array.from(document.querySelectorAll('[data-sku]')); } catch (e) {}
  if (dataSkuEls.length) {
    out.push({
      strategy: 'data-sku',
      count: dataSkuEls.length,
      samples: dataSkuEls.slice(0, limit).map(function (el) {
        return {
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
          sku: (el.getAttribute('data-sku') || '').slice(0, 20),
          text: (el.textContent || '').trim().slice(0, 30),
          disabled: JD._guessStockStatus(el) === '无货'
        };
      })
    });
  }

  // 2. 类名特征探测
  var classHints = ['sku', 'choose', 'attr', 'variant', 'option', 'norm'];
  for (var hi = 0; hi < classHints.length; hi++) {
    if (out.length >= 10) break;
    var hint = classHints[hi];
    var els = [];
    try {
      els = Array.from(document.querySelectorAll('[class*="' + hint + '"]'));
    } catch (e) { continue; }
    var samples = [];
    for (var ei = 0; ei < els.length && samples.length < 5; ei++) {
      var e = els[ei];
      var text = (e.textContent || '').trim();
      if (text.length < 2 || text.length > 200) continue;
      var cls = typeof e.className === 'string' ? e.className : '';
      // 去重
      var dup = false;
      for (var si = 0; si < samples.length; si++) {
        if (samples[si].cls === cls.slice(0, 60) && samples[si].text === text.slice(0, 30)) {
          dup = true; break;
        }
      }
      if (dup) continue;
      samples.push({
        tag: e.tagName.toLowerCase(),
        cls: cls.slice(0, 60),
        text: text.slice(0, 30),
        childrenCount: e.children.length
      });
    }
    if (samples.length) {
      out.push({ strategy: 'class-hint-' + hint, count: els.length, samples: samples });
    }
  }

  return out;
};

/**
 * 从页面内嵌 JSON 里解析完整 SKU 数据。
 *
 * 京东新版模板把全部 SKU 组合（每款的价格、库存）塞在
 * window.pageConfig 或 ld+json 脚本里。DOM 里只有当前
 * 选中款的价格时，从这里兜底补全。
 */
JD._extractSkuFromPageData = function () {
  var skus = [];

  // 1. window.pageConfig.product.sku 系列
  try {
    if (window.pageConfig && window.pageConfig.product) {
      var p = window.pageConfig.product;
      if (p.colorSize && Array.isArray(p.colorSize)) {
        var colorSize = p.colorSize;
        for (var i = 0; i < colorSize.length; i++) {
          var cs = colorSize[i];
          skus.push({
            skuId: String(cs.skuId || cs.SkuId || ''),
            name: cs.name || cs.label || '',
            price: cs.price ? '¥' + cs.price : '',
            stock: cs.stockState !== undefined ? (cs.stockState === 0 ? '无货' : '有货') : '未知',
            image: cs.imagePath || ''
          });
        }
      }
    }
  } catch (e) {}

  // 2. ld+json 的 Product 节点
  if (!skus.length) {
    try {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var si = 0; si < scripts.length; si++) {
        try {
          var json = scripts[si].textContent || '';
          if (!json) continue;
          var data = JSON.parse(json);
          if (data && data['@type'] === 'Product' && data.name) {
            var offers = data.offers;
            if (!offers) continue;
            if (!Array.isArray(offers)) offers = [offers];
            for (var oi = 0; oi < offers.length; oi++) {
              var o = offers[oi];
              skus.push({
                skuId: o.sku || '',
                name: o.name || '',
                price: o.price ? ('¥' + o.price) : '',
                stock: o.availability ? (
                  /OutOfStock|SoldOut/i.test(o.availability) ? '无货' : '有货'
                ) : '未知'
              });
            }
          }
          if (skus.length) break;
        } catch (e) {}
      }
    } catch (e) {}
  }

  return skus;
};

/**
 * 提取商品款式/变体选项。
 *
 * 不点击任何选项（点击会改变页面状态，破坏后续评论采集）。
 * 只读 DOM + 内嵌 JSON 数据（window.pageConfig / ld+json）。
 *
 * @returns {Array} [{属性分类, 选项: [{选项名称, SKU, 价格, 库存状态, selected}]}]
 */
JD.extractProductVariants = function () {
  var groups = [];

  // ═══ 策略 A：基于 data-sku ═══
  var dataSkuEls = [];
  try { dataSkuEls = Array.from(document.querySelectorAll('[data-sku]')); } catch (e) {}

  // 过滤掉搜索结果卡片、推荐卡里的 data-sku
  var variantEls = [];
  for (var i = 0; i < dataSkuEls.length; i++) {
    var el = dataSkuEls[i];
    // 跳过 gl-item / 推荐卡 / 非当前商品的 data-sku
    if (el.closest && el.closest('[class*="gl-item"], [class*="plugin_goodsCardWrapper"], [class*="cross_platform_card"]')) {
      continue;
    }
    variantEls.push(el);
  }

  if (variantEls.length >= 2) {
    // 按父容器分组：往上 1-4 层找有多个 data-sku 子元素的容器
    var groupMap = new Map();
    for (var vi = 0; vi < variantEls.length; vi++) {
      var el2 = variantEls[vi];
      var parent = el2.parentElement;
      for (var p = 0; p < 4 && parent; p++) {
        var dataChildren = 0;
        try { dataChildren = parent.querySelectorAll('[data-sku]').length; } catch (e) {}
        if (dataChildren >= 2) break;
        parent = parent.parentElement;
      }
      if (!parent) continue;
      var key = parent;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(el2);
    }

    groupMap.forEach(function (items, container) {
      if (items.length < 2) return;
      var groupName = JD._guessVariantGroupName(container);
      var options = [];
      for (var ii = 0; ii < items.length; ii++) {
        var item = items[ii];
        // 选项名：清理掉价格和掩码符号
        var raw = (item.textContent || '').trim();
        raw = raw.replace(/[¥￥]\s*[\d.]+/g, '').replace(/无货\s*$/g, '').trim();
        options.push({
          选项名称: raw.slice(0, 40),
          SKU: (item.getAttribute('data-sku') || '').trim(),
          价格: JD._findPriceInElement(item),
          库存状态: JD._guessStockStatus(item),
          selected: JD._isSelected(item)
        });
      }
      groups.push({ 属性分类: groupName, 选项: options });
    });
    if (groups.length) return groups;
  }

  // ═══ 策略 C：重复子元素模式（同前缀类名） ═══
  // 新版模板用 specification-item-sku 这类 BEM 类名，没有 data-sku。
  // 特点：一个容器里 ≥3 个直接子元素，它们的类名有共同前缀。
  if (!groups.length) {
    try {
      var containers = Array.from(document.querySelectorAll('div'));
      for (var ci = 0; ci < containers.length && groups.length < 10; ci++) {
        var container = containers[ci];
        var kids = container.children;
        if (kids.length < 3 || kids.length > 80) continue;
        // 统计子元素中是否有共同学类名前缀（如 specification-item-sku）
        var classCounts = new Map();
        var skuKids = [];
        for (var ki = 0; ki < kids.length; ki++) {
          var k = kids[ki];
          var cls = typeof k.className === 'string' ? k.className : '';
          if (!cls) continue;
          // 「规格/变体」相关的类名才可能是款式选项
          if (!/(sku|spec|attr|choose|norm|variant|option)/i.test(cls)) continue;
          var prefix = cls.split(' ')[0].replace(/[-_]{1,2}(sel|img|active|selected|disabled)$/i, '');
          var count = classCounts.get(prefix) || 0;
          classCounts.set(prefix, count + 1);
          if (!skuKids.some(function (x) { return x === k; })) skuKids.push(k);
        }
        // 找到一个前缀覆盖 ≥3 个子元素 → 这是款式组
        var bestPrefix = '';
        var bestCount = 0;
        classCounts.forEach(function (v, k2) {
          if (v > bestCount) { bestCount = v; bestPrefix = k2; }
        });
        if (bestCount < 3) continue;
        var groupName = JD._guessVariantGroupName(container);
        var options = [];
        var seen = new Set();
        for (var oi = 0; oi < skuKids.length; oi++) {
          var oEl = skuKids[oi];
          var oCls = typeof oEl.className === 'string' ? (oEl.className || '') : '';
          var oPrefix = oCls.split(' ')[0].replace(/[-_]{1,2}(sel|img|active|selected|disabled)$/i, '');
          if (oPrefix !== bestPrefix) continue;
          var raw = (oEl.textContent || '').trim();
          raw = raw.replace(/[¥￥]\s*[\d.]+/g, '').trim();
          if (raw.length < 2 || raw.length > 60) continue;
          // 去重
          var key = raw.slice(0, 30);
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            选项名称: raw.slice(0, 40),
            SKU: (oEl.getAttribute && oEl.getAttribute('data-sku')) || '',
            价格: JD._findPriceInElement(oEl),
            库存状态: JD._guessStockStatus(oEl),
            selected: JD._isSelected(oEl)
          });
        }
        if (options.length >= 2) {
          groups.push({ 属性分类: groupName, 选项: options });
        }
      }
    } catch (e) {}
  }

  // ═══ 策略 B：类名特征容器 ═══
  for (var ci = 0; ci < JD.SELECTORS.VARIANT_CONTAINER.length; ci++) {
    if (groups.length) break;
    var containers = [];
    try { containers = Array.from(document.querySelectorAll(JD.SELECTORS.VARIANT_CONTAINER[ci])); } catch (e) { continue; }
    for (var cj = 0; cj < containers.length; cj++) {
      var container = containers[cj];
      var kids = Array.from(container.children).filter(function (c) {
        var t = (c.textContent || '').trim();
        return t.length > 0 && t.length < 80;
      });
      if (kids.length < 2) continue;
      var groupName2 = JD._guessVariantGroupName(container);
      var options2 = [];
      for (var ki = 0; ki < kids.length; ki++) {
        var k = kids[ki];
        options2.push({
          选项名称: (k.textContent || '').trim().slice(0, 40),
          SKU: (k.getAttribute && k.getAttribute('data-sku')) || '',
          价格: JD._findPriceInElement(k),
          库存状态: JD._guessStockStatus(k),
          selected: JD._isSelected(k)
        });
      }
      groups.push({ 属性分类: groupName2, 选项: options2 });
    }
  }

    // 款式名拿到但 SKU/价格缺失时，用页面内嵌 JSON（window.pageConfig / ld+json）
  // 补全每款对应的 SKU、价格、库存
  try {
    const jsonSkus = JD._extractSkuFromPageData();
    if (jsonSkus.length && groups.length) {
      const byName = {};
      for (const sku of jsonSkus) {
        if (sku.name) byName[sku.name] = sku;
      }
      for (const group of groups) {
        for (const opt of group.选项 || []) {
          if (opt.SKU && opt.价格) continue;
          let matched = null;
          if (!opt.SKU && opt.选项名称 && byName[opt.选项名称]) {
            matched = byName[opt.选项名称];
          } else if (opt.选项名称) {
            // 去掉【】促销标签后模糊匹配
            const stripped = opt.选项名称.replace(/【[^】]*】/g, '').trim();
            for (const sku of jsonSkus) {
              if (!sku.name) continue;
              const n = String(sku.name).replace(/【[^】]*】/g, '').trim();
              if (stripped && (stripped === n || (n.indexOf(stripped) >= 0 && stripped.length >= 3))) {
                matched = sku;
                break;
              }
            }
          }
          if (matched) {
            if (!opt.SKU) opt.SKU = matched.skuId || matched.sku || '';
            if (!opt.价格) opt.价格 = matched.price || '';
            if (matched.stock && (opt.库存状态 === '未知' || opt.库存状态 === '有货')) opt.库存状态 = matched.stock;
          }
        }
      }
    }
  } catch (e) {}

  return groups;
};
/**
 * 点击模式补款式价格：逐个点击款式项，等主价格刷新后读价，最后恢复原款。
 *
 * 仅当页面没有内嵌 JSON 价格数据（window.pageConfig / ld+json 为空）时使用。
 * 副作用：切换页面上选中的 SKU、触发价格刷新请求；款式越多耗时越长。
 * 缺货款跳过不点，恢复原选中款。
 */
JD.fillVariantPricesByClick = async function (groups, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 2500;
  const settleMs = opts.settleMs || 1500;
  const priceSel = '[class*="product-price--main"]';
  const itemSel = '[class*="specification-item-sku"], [class*="sku-item"], [data-sku]';

  const readMainPrice = () => {
    try {
      const el = document.querySelector(priceSel);
      if (!el) return '';
      const m = (el.textContent || '').trim().match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
      return m ? ('¥' + m[1]) : '';
    } catch (e) {
      return '';
    }
  };

  const clean = (t) =>
    String(t || '').replace(/[¥￥]\s*[\d.]+/g, '').replace(/无货\s*$/g, '').trim();

  const findItemEl = (name) => {
    const target = clean(name);
    if (!target) return null;
    let items = [];
    try {
      items = Array.from(document.querySelectorAll(itemSel));
    } catch (e) {
      return null;
    }
    for (const el of items) {
      if (clean((el.textContent || '')) === target) return el;
    }
    for (const el of items) {
      const t = clean((el.textContent || ''));
      if (t && target.length >= 3 && t.indexOf(target) >= 0) return el;
    }
    return null;
  };

  const waitPrice = async (beforePrice) => {
    const start = Date.now();
    while (Date.now() - start < Math.min(timeout, settleMs)) {
      const p = readMainPrice();
      if (p && p !== beforePrice) return p;
      await JD.sleep(220);
    }
    return readMainPrice();
  };

  let selectedName = '';
  try {
    const sel = document.querySelector(
      '[class*="specification-item-sku--selected"], [class*="specification-item-sku--sel"], .selected'
    );
    if (sel) selectedName = (sel.textContent || '').trim();
  } catch (e) {}

  let clicked = 0;
  const cap = opts.cap || 30;
  let needRestore = false;

  for (const group of groups || []) {
    for (const opt of group.选项 || []) {
      if (clicked >= cap) break;
      if (opt.价格 || opt.库存状态 === '无货') continue;
      const el = findItemEl(opt.选项名称);
      if (!el) continue;
      if (JD._guessStockStatus(el) === '无货') {
        opt.库存状态 = '无货';
        continue;
      }
      const before = readMainPrice();
      try {
        el.click();
        needRestore = true;
      } catch (e) {
        continue;
      }
      clicked += 1;
      const after = await waitPrice(before);
      if (after) {
        opt.价格 = after;
      }
      await JD.sleep(250);
    }
    if (clicked >= cap) break;
  }

  if (needRestore && selectedName) {
    try {
      const el = findItemEl(selectedName);
      if (el) {
        el.click();
        await waitPrice(readMainPrice());
      }
    } catch (e) {}
  }

  return { clicked, groups };
};


/**
 * 把视口拉到「商品详情 / 规格与包装」区。
 *
 * 参数表和评论区一样是懒渲染的：不滚到它附近，DOM 里根本没有这些节点。
 * 而且参数区在页面中部，如果当前已经停在页面底部（比如刚诊断过评论区），
 * 只往下滚永远碰不到它——所以先回到顶部再按步进往下滚，确保参数区
 * 被完整经过；找到参数表或「商品详情 / 规格与包装」标题就停下来。
 */
JD.scrollToParamSection = async function () {
  // 参数表已经渲染时就地返回，不滚动页面
  if (JD.pick(document, JD.SELECTORS.DETAIL_PARAM_TABLE)) return true;

  // 页面可能在页面底部或中间，先回到顶部再往下走
  window.scrollTo({ top: 0 });
  await JD.sleep(500);

  const findAnchor = () => {
    for (const label of JD.SELECTORS.LABEL_PARAM_SECTION) {
      const el = JD.findSmallestByText(label);
      if (el) return el;
    }
    return null;
  };

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
 * 点击「规格与包装 / 商品详情」等标签，让被隐藏的参数表显示出来。
 *
 * 有些版式的参数区收在标签页里，不点开就一直是 display:none 或懒渲染。
 * 传 only 就只点那一个标签，否则按 LABEL_PARAM_TAB 的配置顺序逐个尝试。
 * 都是页内切换，不会触发跳转，可以放心在内容脚本里做。
 */
JD.clickParamTab = function (only) {
  const list = only ? [only] : JD.SELECTORS.LABEL_PARAM_TAB;
  for (const raw of list) {
    if (!/^text:/.test(raw)) continue;
    const btn = JD.findByText([raw]);
    if (!btn) continue;
    const label = raw.slice(5);
    try {
      btn.click();
      return { found: true, clicked: true, label };
    } catch (e) {
      return { found: true, clicked: false, label, error: String((e && e.message) || e) };
    }
  }
  return { found: false, clicked: false };
};

/**
 * 提取「规格与包装」参数表（品牌、商品编号、保质期类别等）。
 *
 * 流程：
 *   0. 参数表已经在页面上就直接用，不滚动不点击
 *   1. 逐个点开参数相关标签（用户实测可通过点「商品详情」获取参数表）
 *   2. 还没有就滚到参数区再解析（参数区和评论区一样是懒渲染的）
 *   3. 固定补滚几轮触发懒加载
 * 只读参数文本，参数区下方的商品介绍图片不处理。
 */
JD.extractProductParams = async function () {
  // 0. 参数表已经在页面上了
  let params = JD.parseProductParams();
  if (Object.keys(params).length) return params;

  // 1. 逐个点开标签再解析
  for (const raw of JD.SELECTORS.LABEL_PARAM_TAB) {
    const click = JD.clickParamTab(raw);
    if (!click.clicked) continue;
    await JD.sleep(700);
    params = JD.parseProductParams();
    if (Object.keys(params).length) return params;
  }

  // 2. 滚到参数区再解析
  await JD.scrollToParamSection();
  await JD.sleep(600);
  params = JD.parseProductParams();

  // 3. 懒加载兜底：固定补滚几轮
  for (let i = 0; i < 3 && !Object.keys(params).length; i++) {
    window.scrollBy({ top: 500, behavior: 'smooth' });
    await JD.sleep(700);
    params = JD.parseProductParams();
  }

  return params;
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
 * 页面诊断：报告选择器命中情况和真实 DOM 结构。
 *
 * 必须先滚动之后才探测评论和参数区，否则页面上根本没有这些节点，
 * 所有选择器都会是 0，看起来像选择器写错了，其实是还没加载。
 * 参数区在评论区上方，参数提取会自己先滚到参数区，
 * 之后滚评论区正好从参数区继续往下走，所以参数提取放在最前面。
 */
JD.diagnose = async function (options = {}) {
  const S = JD.SELECTORS;
  const deep = options.deep !== false;

  // 商品详情参数表要在滚评论区之前解析：提取过程会自己滚动，
  // 先做能保证后面滚到评论区时是从参数区继续往下，不会重叠
  const params = await JD.extractProductParams();

  // 再把评论区点开并滚出来，这样下面的探测才有意义
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

  // 商品详情参数表（品牌、商品编号、保质期类别等）。
  result.参数表 = params;

  // 页面上是否出现常见参数名和参数区入口文字。
  // 用于判断参数区到底渲染了没有：标签都在、参数表却为空，
  // 说明是结构/选择器的问题；标签一个都不在，说明参数区还没被渲染。
  result.参数标签 = (() => {
    const probes = [
      '品牌', '商品名称', '商品编号', '保质期', '规格与包装', '商品详情',
      '商品参数', '规格参数', '商品规格', '产品参数', '包装清单'
    ];
    return probes.map((label) => ({
      label,
      found: Boolean(JD.findSmallestByText(label))
    }));
  })();

  // 参数名在页面里的真实上下文链。
  // 参数表取不到/取不全时，这个能看出文字是「键值行」「脚本 JSON」
  // 还是「裸标签」，直接决定下一步往哪修。
  result.参数行 = ['品牌', '商品编号', '保质期', '净含量', '货号', '型号'].map(
    (label) => JD.probeParamAnchor(label)
  );

  // 顶部字段（价格 / 店铺 / 好评率）的盲区探测。
  // 这三个字段在新版模板上取不到/取错，先看真实结构再定选择器：
  //   - 价格：商品真实价 vs 推荐卡（cross_platform_card）
  //   - 店铺：top-name / 店铺主页链接 / 标签 三处
  //   - 好评率：页面上的真实好评文案
  result.顶部探测 = {
    价格: JD.probePrices(),
    店铺: JD.probeStore(),
    好评率: JD.probeGoodRate(),
    款式: JD.probeVariants()
  };

  // 深度模式才导出 DOM 结构，输出比较长
  if (deep) {
    result.structure = {
      评论条目: JD.dumpSelector('.comment-root ul.list > li', { maxDepth: 2, maxNodes: 18 }),
      店铺区: JD.dumpArea('关注店铺', { maxDepth: 2, maxNodes: 16 }),
      价格区: JD.dumpArea('到手价', { maxDepth: 2, maxNodes: 12 }),
      // 参数区：先找入口文字，导出它附近的真实结构。
      // 参数表取不到时，回传这一段就能定位到真实类名，不用翻开发者工具。
      参数区: (() => {
        // 入口文字（标签栏）优先；然后才是真实参数行（品牌/保质期），
        // 从参数行往上导出能看到新模板的「行」长什么样。
        for (const a of ['规格参数', '商品详情', '售后保障', '保质期', '品牌', '商品编号']) {
          const d = JD.dumpArea(a, { maxDepth: 3, maxNodes: 24 });
          if (d.found) return d;
        }
        return { found: false, note: '诊断时页面上没有找到任何参数区文字锚点' };
      })(),
      // 款式区：先基于 data-sku 导出真实 DOM；没有就按颜色/尺码标签走
      款式区: (() => {
        const skuDump = JD.dumpSelector('[data-sku]', { maxDepth: 3, maxNodes: 24 });
        if (skuDump.found) return skuDump;
        // specification-item-sku 类名：新版模板无 data-sku 属性的款式项
        const sel = JD.pick(document, ['[class*="specification-item"]', '[class*="spec-item"]', '[class*="sku-item"]']);
        if (sel) {
          const d = JD.dumpArea((sel.textContent || '').trim().slice(0, 12), { maxDepth: 3, maxNodes: 30 });
          if (d.found) return d;
        }
        for (const a of JD.SELECTORS.LABEL_VARIANT_GROUP.slice(0, 6)) {
          const d = JD.dumpArea(a, { maxDepth: 3, maxNodes: 24 });
          if (d.found) return d;
        }
        return { found: false, note: '诊断时页面上没有找到款式区锚点（无 data-sku，无颜色/尺码/规格标签）' };
      })()
    };

    // 款式提取实机验证：直接跑一次 extractProductVariants 看返回值
    result.款式提取结果 = JD.extractProductVariants();
  // 页面内嵌 JSON（window.pageConfig / ld+json）里的 SKU 价格数据原始形态，
  // 款式补全靠它；空数组说明页面没有内嵌价格，只能走点击模式
  result.款式价格数据 = JD._extractSkuFromPageData();

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
