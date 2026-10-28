// プリセットパレットとプロンプトテンプレート

export const PALETTES = {
  free: { label: "おまかせ（AIが選ぶ）", colors: [] },
  pico8: {
    label: "PICO-8 (16色)",
    colors: ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
      "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"],
  },
  sweetie16: {
    label: "Sweetie 16 (16色)",
    colors: ["#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179",
      "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57"],
  },
  gameboy: { label: "ゲームボーイ風 (4色)", colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] },
  mono: { label: "白黒 (2色)", colors: ["#000000", "#ffffff"] },
  custom: { label: "カスタム（自分で編集）", colors: ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"] },
};

// fields の {key} が text に差し込まれる。settings はテンプレ選択時に画面へ反映される推奨設定
export const TEMPLATES = [
  {
    id: "free", label: "自由入力",
    fields: [], text: "",
    settings: {},
  },
  {
    id: "character", label: "キャラクター",
    fields: [
      { key: "who", label: "キャラ", placeholder: "剣を持った勇者" },
      { key: "dir", label: "向き", placeholder: "正面", options: ["正面", "右", "左", "後ろ", "斜め前"] },
      { key: "extra", label: "特徴", placeholder: "青いマント、金髪" },
    ],
    text: "ゲーム用のキャラクタースプライト。{who}、{dir}向きの全身立ち絵。{extra}",
    settings: { size: 32, transparent: true, outline: true, tileable: false },
  },
  {
    id: "monster", label: "モンスター",
    fields: [
      { key: "who", label: "モンスター", placeholder: "スライム" },
      { key: "color", label: "色", placeholder: "緑色" },
      { key: "extra", label: "特徴", placeholder: "王冠をかぶっている" },
    ],
    text: "RPGの敵モンスターのスプライト。{color}の{who}。{extra}",
    settings: { size: 32, transparent: true, outline: true, tileable: false },
  },
  {
    id: "item", label: "アイテム・アイコン",
    fields: [
      { key: "item", label: "アイテム", placeholder: "回復ポーション" },
      { key: "extra", label: "特徴", placeholder: "赤い液体、ガラス瓶" },
    ],
    text: "ゲームのアイテムアイコン。{item}。{extra}。中央に大きく配置。",
    settings: { size: 16, transparent: true, outline: true, tileable: false, symmetry: false },
  },
  {
    id: "tile", label: "マップタイル",
    fields: [
      { key: "ground", label: "地形", placeholder: "草原", options: ["草原", "土", "石畳", "レンガの壁", "水面", "砂", "雪", "木の床"] },
      { key: "extra", label: "特徴", placeholder: "小さな花が点在" },
    ],
    text: "上から見下ろし型RPGのマップタイル。{ground}。{extra}",
    settings: { size: 16, transparent: false, outline: false, tileable: true, symmetry: false },
  },
  {
    id: "pattern", label: "模様・パターン",
    fields: [
      { key: "motif", label: "モチーフ", placeholder: "和風の青海波" },
      { key: "extra", label: "特徴", placeholder: "藍色と白" },
    ],
    text: "繰り返し可能な模様パターン。{motif}。{extra}",
    settings: { size: 16, transparent: false, outline: false, tileable: true },
  },
];

export const SIZE_PRESETS = [8, 16, 24, 32, 48, 64];
