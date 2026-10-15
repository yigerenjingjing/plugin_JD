/**
 * 京东页面选择器与限速参数。
 *
 * 移植自源项目的 jd_config.py，保持「当前结构 → 语义前缀兜底 → 旧版兼容」
 * 的尝试顺序。列表里靠前的先试，匹配到就用。
 *
 * 注意：扩展里的选择器是标准 CSS 选择器，源项目里的 DrissionPage 语法
 * （css: / text: 前缀）在这里已经去掉。纯文本匹配由 utils.findByText 处理。
 */

// 用 var 而不是 const：多个内容脚本文件共享同一个全局作用域，
// 重复声明 const 会抛 "Identifier 'JD' has already been declared"。
var JD = (globalThis.JD = globalThis.JD || {});

JD.SELECTORS = {
  // ── 搜索结果页：商品卡片 ──
  CARD: [
    '[data-sku]',
    '[class*="plugin_goodsCardWrapper"]',
    'li.gl-item',
    '.gl-item',
    '[class*="_goods_item_"]'
  ],

  NAME: [
    '[class*="_goods_title_container"]',
    '._newStyle_1k2fi_39',
    '._text_1x4i2_30',
    '.p-name em',
    '.p-name a',
    '[class*="_text_"]'
  ],

  PRICE: [
    '._price_9y3st_31',
    '._price_1tn4o_13',
    '.p-price i',
    '.p-price',
    '[class*="_price_"]'
  ],

  PROMOTION: [
    '[class*="_text-list"]',
    '._tags_hzhkm_2',
    '.p-icons',
    '[class*="_tags_"]'
  ],

  STORE: [
    '._name_3z0zc_15',
    '._name_d19t5_35',
    '.p-shop a',
    '.p-shop',
    '[class*="_name_"]'
  ],

  SALES: [
    '._goods_volume_1d8up_1',
    '._goods_volume_1xkku_1',
    '.p-commit',
    '[class*="_goods_volume_"]'
  ],

  // ── 商品详情页（item.jd.com）──
  // 详情页结构与搜索页不同，这里给出常见兜底；取不到时沿用搜索结果页的卡片数据。
  DETAIL_NAME: [
    '.sku-name',
    '.itemInfo-wrap .sku-name',
    '[class*="sku-name"]',
    '#name h1'
  ],

  DETAIL_PRICE: [
    '.summary-price .p-price .price',
    '.p-price .price',
    '#jd-price',
    '[class*="price_"]'
  ],

  DETAIL_STORE: [
    '.J-hove-wrap .name a',
    '#popbox .mt a',
    '.shopName',
    '.J-hove-wrap .name'
  ],

  DETAIL_SALES: [
    '#comment-count',
    '.J-comm-curr-sku',
    '[class*="comment-count"]'
  ],

  // ── 评论 ──
  // 覆盖商品详情页内嵌的评论区。
  // 京东新版 PC 详情页把评论区放在「大家评」标签下，类名换成了带下划线的
  // 哈希串，所以后面几条用属性包含匹配兜底，靠后放避免误命中。
  COMMENT_TEXT: [
    '.jdc-pc-rate-card-main-desc',
    '.comment-con',
    '[class*="rate-card-main-desc"]',
    '[class*="_commentItem"] [class*="_desc"]',
    '[class*="comment-item"] [class*="desc"]',
    '[class*="_comment_"] [class*="_content_"]',
    '[class*="commentList"] [class*="content"]',
    '[class*="_commentContent"]'
  ],

  // 评论「条目」选择器：命中整个卡片而不是正文。
  // 实测新版 PC 详情页的评论列表是 div.comment-root > div.mt24 > ul.list，
  // 每条评论是里面的 li，但 li 里同时有用户名、商品规格和正文，
  // 所以需要配合 JD.extractCommentText 抽取正文。
  COMMENT_ITEM: [
    '.comment-root ul.list > li',
    'ul.list > li',
    '[class*="comment-root"] ul > li',
    '[class*="comment"] ul > li'
  ],

  ALL_COMMENT_BUTTON: [
    '.all-btn',
    '#comment',
    'text:全部评价',
    'text:查看全部评价'
  ],

  SORT_SALES: [
    'text:销量',
    'text:按销量',
    'text:销量排序',
    'text:销量优先'
  ],

  // ── 文字锚点 ──
  // 京东的哈希类名每次改版都会变，但页面上的中文标签很少变。
  // 这些锚点用于「先找到标签，再读它附近的数值」，比抠类名稳得多。
  LABEL_SALES: ['累计评价', '商品评价', '评价'],
  LABEL_PRICE: ['到手价', '京东价', '秒杀价'],
  LABEL_STORE: ['店铺', '卖家'],
  LABEL_COMMENT_AREA: ['买家评价', '商品评价', '用户评价', '大家评'],
  LABEL_COMMENT_TAB: ['大家评', '商品评价', '全部评价', '买家评价'],

  // ── 评论容器 ──
  // 点开「全部评价」后的评论列表容器。新版用的是哈希类名
  // （实测为 _rateListContainer_1ygkr_45），只能用前缀匹配。
  COMMENT_CONTAINER: [
    '[class*="_rateListContainer_"]',
    '[class*="rateListContainer"]',
    '.comment-root',
    '[class*="comment-root"]',
    'ul.list'
  ]
};

/** 无效评论文案，移植自 jd_config.INVALID_COMMENT。 */
JD.INVALID_COMMENT = '此用户未填写评价内容';

/** 评论最小有效长度，移植自 jd_config.MIN_COMMENT_LENGTH。 */
JD.MIN_COMMENT_LENGTH = 5;

/**
 * 限速参数，移植自 jd_config.py 的随机区间。
 * 保持同一套数值，避免扩展和源项目行为不一致。
 */
JD.LIMITS = {
  CRAWL_DELAY_MIN: 3000,
  CRAWL_DELAY_MAX: 8000,
  COMMENT_SCROLL_DELAY_MIN: 800,
  COMMENT_SCROLL_DELAY_MAX: 2000,
  PAGE_LOAD_DELAY_MIN: 800,
  PAGE_LOAD_DELAY_MAX: 1500,
  SCROLL_STEP_MIN: 1,
  SCROLL_STEP_MAX: 3,
  SCROLL_PIXEL_MIN: 200,
  SCROLL_PIXEL_MAX: 600,
  SCROLL_RETRIES: 5,
  PAGE_READY_TIMEOUT: 15000
};
