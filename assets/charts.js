// === Mermaid 初始化 ===
mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  themeVariables: {
    primaryColor: '#161b22',
    primaryTextColor: '#e6edf3',
    primaryBorderColor: '#58a6ff',
    lineColor: '#8b949e',
    secondaryColor: '#21262d',
    tertiaryColor: '#0d1117',
    fontFamily: 'InstrumentSans, sans-serif',
    fontSize: '14px'
  },
  flowchart: {
    curve: 'basis',
    padding: 16
  },
  securityLevel: 'loose'
});

// === ECharts 图表 ===
(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var green = style.getPropertyValue('--green').trim();
  var yellow = style.getPropertyValue('--yellow').trim();

  // --- 开发周期甘特图 ---
  var chartTimeline = echarts.init(document.getElementById('chart-timeline'), null, { renderer: 'svg' });

  var phases = [
    { name: 'P1 交易所核心', start: 1, end: 4, color: accent },
    { name: 'P2 交易终端', start: 5, end: 9, color: accent },
    { name: 'P3 仿真市场', start: 10, end: 14, color: accent2 },
    { name: 'P4 信息生态', start: 15, end: 18, color: yellow },
    { name: 'P5 性能工程', start: 19, end: 21, color: yellow },
    { name: 'P6 测试与发布', start: 22, end: 24, color: green }
  ];

  var milestones = [
    { name: '撮合引擎可运行', week: 4, phase: 'P1' },
    { name: '双模式交易闭环', week: 9, phase: 'P2' },
    { name: '多标的市场上线', week: 14, phase: 'P3' },
    { name: '论坛新闻闭环', week: 18, phase: 'P4' },
    { name: '300标的流畅运行', week: 21, phase: 'P5' },
    { name: '可发布版本', week: 24, phase: 'P6' }
  ];

  chartTimeline.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: {
      left: 130,
      right: 40,
      top: 30,
      bottom: 40
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: 25,
      interval: 2,
      axisLine: { lineStyle: { color: rule } },
      axisLabel: {
        color: muted,
        fontSize: 11,
        formatter: function(val) { return 'W' + val; }
      },
      splitLine: { lineStyle: { color: rule, type: 'dashed', opacity: 0.3 } }
    },
    yAxis: {
      type: 'category',
      data: phases.map(function(p) { return p.name; }).reverse(),
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: ink, fontSize: 12 },
      axisTick: { show: false }
    },
    series: [
      {
        type: 'custom',
        renderItem: function(params, api) {
          var categoryIndex = api.value(0);
          var start = api.coord([api.value(1), categoryIndex]);
          var end = api.coord([api.value(2), categoryIndex]);
          var height = api.size([0, 1])[1] * 0.5;
          var phase = phases[phases.length - 1 - categoryIndex];

          return {
            type: 'rect',
            shape: {
              x: start[0],
              y: start[1] - height / 2,
              width: end[0] - start[0],
              height: height,
              r: 4
            },
            style: {
              fill: phase.color,
              opacity: 0.25,
              stroke: phase.color,
              lineWidth: 1.5
            }
          };
        },
        encode: {
          x: [1, 2],
          y: 0
        },
        data: phases.map(function(p, i) {
          return [i, p.start, p.end];
        }).reverse()
      },
      {
        type: 'scatter',
        symbolSize: 12,
        symbol: 'diamond',
        data: milestones.map(function(m, i) {
          var phaseIndex = phases.findIndex(function(p) { return p.name.indexOf(m.phase) === 0; });
          return [m.week, phases.length - 1 - phaseIndex];
        }),
        itemStyle: {
          color: function(params) {
            var phase = milestones[params.dataIndex].phase;
            var phaseObj = phases.find(function(p) { return p.name.indexOf(phase) === 0; });
            return phaseObj ? phaseObj.color : accent;
          },
          borderColor: ink,
          borderWidth: 1.5
        },
        label: {
          show: true,
          position: 'top',
          formatter: function(params) {
            return milestones[params.dataIndex].name;
          },
          color: ink,
          fontSize: 10,
          fontWeight: 700,
          offset: [0, -4]
        },
        tooltip: {
          formatter: function(params) {
            var m = milestones[params.dataIndex];
            return m.name + '<br/>第 ' + m.week + ' 周';
          }
        }
      }
    ],
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      backgroundColor: bg2,
      borderColor: rule,
      textStyle: { color: ink },
      formatter: function(params) {
        if (params.seriesIndex === 0) {
          var phase = phases[phases.length - 1 - params.dataIndex];
          return phase.name + '<br/>第 ' + phase.start + '-' + phase.end + ' 周';
        }
        return params.name;
      }
    }
  });

  window.addEventListener('resize', function() {
    chartTimeline.resize();
  });
})();
