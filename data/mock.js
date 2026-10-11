/**
 * mock 数据（坐标统一为 GCJ-02，直接对齐高德底图）
 * 全部为演示用模拟数据，无需真实接口。
 *
 * 说明：为了让车辆"沿道路行驶"而不是在站点之间直线瞬移，
 * 这里用 Catmull-Rom 样条把相邻站点之间采样出若干中间路径点，
 * 最终暴露 `path`（[lat,lng] 数组）给渲染层使用。
 */

// 每个站间采样的中间点数（越大越平滑；站点 k 对应 path 下标 k*SAMPLES_PER_SEGMENT）
var SAMPLES_PER_SEGMENT = 5;

/* ---------------- 曲线采样工具 ---------------- */
function catmullRom1D(p0, p1, p2, p3, t) {
  var t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * 把一组控制点用 Catmull-Rom 样条加密成平滑路径
 * @param {Array<{lat:number,lng:number}>} pts 控制点
 * @param {number} S 每段采样数
 * @param {number} [amp] 中间点横向弯曲幅度（度）。站点本身保持不动，
 *                       只让站与站之间的中间点轻微偏移，模拟道路拐弯，避免"一条直线"。
 * @returns {Array<[number,number]>} 路径点数组（[lat,lng]）
 */
function buildRoutePath(pts, S, amp) {
  var n = pts.length;
  var get = function (i) { return pts[Math.max(0, Math.min(n - 1, i))]; };
  var out = [];

  for (var i = 0; i < n - 1; i++) {
    var p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (var s = 0; s < S; s++) {
      var t = s / S;
      out.push([
        catmullRom1D(p0.lat, p1.lat, p2.lat, p3.lat, t),
        catmullRom1D(p0.lng, p1.lng, p2.lng, p3.lng, t)
      ]);
    }
  }
  out.push([pts[n - 1].lat, pts[n - 1].lng]);

  // 给中间点加轻微横向弯曲（站点 j%S===0 保持原位，确保站点与路线精确重合）
  if (amp) {
    var m = out.length;
    for (var j = 1; j < m - 1; j++) {
      if (j % S === 0) continue;
      var prev = out[j - 1], next = out[j + 1];
      var dLat = next[0] - prev[0], dLng = next[1] - prev[1];
      var len = Math.sqrt(dLat * dLat + dLng * dLng) || 1;
      var k = amp * Math.sin((j / m) * Math.PI * 3.2);   // 沿全程来回轻微摆动
      out[j][0] += (-dLng / len) * k;
      out[j][1] += (dLat / len) * k;
    }
  }
  return out;
}

/* ---------------- 公交线路 ---------------- */
var MOCK_BUS_ROUTE = {
  line: "37路",
  direction: "塘朗地铁站 → 塘朗山公园",
  stops: [
    { id: "s1", name: "塘朗地铁站", lat: 22.6071, lng: 113.9902 },
    { id: "s2", name: "学苑大道北", lat: 22.6058, lng: 113.9938 },
    { id: "s3", name: "南科大1号门", lat: 22.6046, lng: 113.9974 },
    { id: "s4", name: "南科大图书馆", lat: 22.6034, lng: 114.0010 },
    { id: "s5", name: "学苑大道中", lat: 22.6022, lng: 114.0046 },
    { id: "s6", name: "南科大3号门", lat: 22.6010, lng: 114.0082 },
    { id: "s7", name: "荔园", lat: 22.5998, lng: 114.0118 },
    { id: "s8", name: "塘朗山公园", lat: 22.5986, lng: 114.0154 }
  ]
};
MOCK_BUS_ROUTE.samplesPerSegment = SAMPLES_PER_SEGMENT;
MOCK_BUS_ROUTE.path = buildRoutePath(MOCK_BUS_ROUTE.stops, SAMPLES_PER_SEGMENT, 0.00055);

// 默认上/下车目标站（索引）
var MOCK_BUS_DEFAULT = { boardIndex: 2, alightIndex: 5 };

// 用户当前位置（南科大1号门附近）
var MOCK_USER_LOCATION = { lat: 22.6042, lng: 113.9968 };

/* ---------------- 打车 ---------------- */
// 司机从西侧驶来，中途一个控制点让路线带一点弧度（更接近真实道路）
// 注意：真实行驶路径在 app.js 里根据"目的地"动态生成（buildRoutePath）
var MOCK_TAXI = {
  plate: "粤B·D8888",
  driver: "李师傅",
  car: "白色比亚迪秦",
  startLat: 22.6092,
  startLng: 113.9860,
  midLat: 22.6075,
  midLng: 113.9905,
  etaMinutes: 3
};

/* ---------------- 打车可选目的地（站名 + 校园地点） ---------------- */
var MOCK_PLACES = [
  { name: "南科大图书馆", lat: 22.6034, lng: 114.0010 },
  { name: "南科大1号门", lat: 22.6046, lng: 113.9974 },
  { name: "南科大3号门", lat: 22.6010, lng: 114.0082 },
  { name: "塘朗地铁站", lat: 22.6071, lng: 113.9902 },
  { name: "学苑大道中", lat: 22.6022, lng: 114.0046 },
  { name: "一食堂", lat: 22.6028, lng: 113.9988 },
  { name: "体育馆", lat: 22.6015, lng: 114.0024 },
  { name: "校医院", lat: 22.6052, lng: 113.9992 },
  { name: "学生宿舍区", lat: 22.6060, lng: 114.0006 },
  { name: "行政楼", lat: 22.6040, lng: 113.9976 }
];

// 默认目的地
var MOCK_TAXI_DEFAULT = 0;
