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
    // 新版模板 A（React BEM）：商品主价在 span.product-price--main 里
    '[class*="product-price--main"]',
    // 新版模板 B（旧 React 组件）：pc-component-price-unit 里是各规格价
    '[class*="pc-component-price-unit"]',
    '.summary-price .p-price .price',
    '.p-price .price',
    '#jd-price',
    '[class*="price_"]'
  ],

  DETAIL_STORE: [
    '.J-hove-wrap .name a',
    '#popbox .mt a',
    '.shopName',
    '.J-hove-wrap .name',
    // 新版模板：店铺名在 div.top-shop-info > div.top-name-tag > div.top-name
    '[class*="top-name"]'
  ],

  DETAIL_SALES: [
    '#comment-count',
    '.J-comm-curr-sku',
    '[class*="comment-count"]'
  ],

  // 好评率独立选择器：新版模板里好评率不在销量文案附近，
  // 而是放在独立的 .applause-rate div 里（形如「超99%买家赞不绝口」）
  DETAIL_GOOD_RATE: [
    '.applause-rate',
    '[class*="applause"]',
    '[class*="good-rate"]',
    '[class*="goodrate"]'
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
  ],

  // ── 商品详情参数表（规格与包装）──
  // 品牌、商品编号、保质期类别等键值对，放在详情页中部的「规格与包装」区。
  // 经典结构是 .Ptable > .Ptable-item > dl（dd.Ptable-tit 是参数名），
  // 顶部还有一条 ul.p-parameter-list 汇总。这些是参数表本身的位置，
  // 参数区下方的商品介绍图片不在其中，不会读到图片。
  DETAIL_PARAM_TABLE: [
    '.Ptable',
    '[class*="Ptable"]',
    'ul.p-parameter-list',
    '[class*="parameter-list"]',
    '[class*="param-list"]',
    '[class*="_params_"]',
    '#detail table'
  ],

  // 参数表的行容器：每行是「名称 + 值」。
  // 靠前的结构更精确（Ptable-item 里的 dl），通用表格放最后兜底。
  DETAIL_PARAM_ITEM: [
    '.Ptable-item dl',
    '[class*="Ptable-item"] dl',
    '[class*="Ptable"] dl',
    'ul.p-parameter-list li',
    '[class*="parameter-list"] li',
    '[class*="param-list"] li',
    '#detail table tr',
    '#detail-tabs-1 table tr',
    // 新版版式的参数区可能用带 _params_ 的哈希类名，dd/li 是行
    '[class*="_params_"] dd',
    '[class*="_params_"] li'
  ],

  // 文字锚点：参数区。页面刚打开时这一片是懒渲染的，要先滚过去才存在。
  LABEL_PARAM_SECTION: ['商品详情', '规格与包装', '包装清单'],

  // 参数区入口标签，逐个尝试点击后解析，text: 前缀走文本查找。
  // 用户实测参数表可以「点击商品页面的商品详情」获取，
  // 所以把「商品详情」也收进来，但放在最后：多数版式默认就是它，
  // 先点更具体的「规格与包装」能少一次点击。
  LABEL_PARAM_TAB: [
    'text:规格与包装',
    'text:包装清单',
    'text:商品参数',
    'text:规格参数',
    'text:商品规格',
    'text:商品详情'
  ],

  // ── 款式/变体选择器（颜色/尺码/规格等可选项）──
  // 策略：data-sku 属性 > 类名特征 > 结构兜底

  // 款式区容器（整个款式选择区域，含多个属性的组）
  VARIANT_CONTAINER: [
    '[class*="choose-wrap"]',
    '[class*="choose-wrap-"]',
    '[class*="sku-choose"]',
    '[class*="sku_choose"]',
    '[class*="attr-choose"]',
    '[class*="attr_choose"]',
    '[class*="_sku_"]',
    '[class*="variant"]',
    '[class*="norms"]',
    '[class*="specification"]',
    'dl[class*="choose"]'
  ],

  // 单个款式分类（如「颜色」下面的一排色块）
  VARIANT_GROUP: [
    '[class*="choose-wrap"] > div',
    '[class*="choose-wrap-"] > div',
    '[class*="attr-choose"] > div',
    '[class*="_sku_"] > div',
    '[class*="norms"] > div',
    '[class*="specification"] > div',
    'dl[class*="choose"] > dd'
  ],

  // 款式文字锚点：组标题常用词
  LABEL_VARIANT_GROUP: [
    '颜色', '尺码', '规格', '版本', '型号', '款式', '类型', '口味', '容量', '香型', '系列', '净含量'
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
