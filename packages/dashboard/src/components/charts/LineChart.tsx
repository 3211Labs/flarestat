import { useEffect, useRef, useState } from 'react';
import type { Chart as ChartType, ChartConfiguration } from 'chart.js';

interface Props {
  labels: string[];
  values: number[];
  color?: string;
  height?: number;
  label?: string;
}

// Lazy-load Chart.js at first mount rather than at module evaluation —
// the library is ~150 kB and used on only two screens. This keeps the
// app shell lean for cold loads on iPhone over cellular.
let chartJsPromise: Promise<typeof import('chart.js')> | null = null;
function loadChartJs() {
  if (!chartJsPromise) {
    chartJsPromise = import('chart.js').then((mod) => {
      mod.Chart.register(
        mod.LineController,
        mod.LineElement,
        mod.PointElement,
        mod.LinearScale,
        mod.CategoryScale,
        mod.Tooltip,
        mod.Filler,
      );
      return mod;
    });
  }
  return chartJsPromise;
}

export default function LineChart({
  labels,
  values,
  color = '#06b6d4',
  height = 160,
  label = '',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartType | null>(null);
  const [ready, setReady] = useState(false);

  // Build the chart once Chart.js is loaded and the canvas is mounted.
  useEffect(() => {
    let cancelled = false;

    loadChartJs().then((mod) => {
      if (cancelled || !canvasRef.current) return;

      const config: ChartConfiguration<'line'> = {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label,
              data: values,
              borderColor: color,
              backgroundColor: `${color}22`,
              tension: 0.3,
              fill: true,
              pointRadius: 0,
              borderWidth: 1.5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              mode: 'index',
              intersect: false,
              backgroundColor: '#141414',
              borderColor: '#222',
              borderWidth: 1,
              titleColor: '#e0e0e0',
              bodyColor: '#e0e0e0',
              titleFont: { family: 'JetBrains Mono', size: 11 },
              bodyFont: { family: 'JetBrains Mono', size: 11 },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: '#555',
                font: { family: 'JetBrains Mono', size: 9 },
                maxTicksLimit: 4,
              },
            },
            y: {
              grid: { color: '#1a1a1a' },
              ticks: {
                color: '#555',
                font: { family: 'JetBrains Mono', size: 9 },
                maxTicksLimit: 4,
              },
            },
          },
        },
      };

      chartRef.current = new mod.Chart(canvasRef.current, config);
      setReady(true);
    });

    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On data updates, mutate and update rather than destroy/recreate.
  useEffect(() => {
    if (!ready || !chartRef.current) return;
    const chart = chartRef.current;
    chart.data.labels = labels;
    if (chart.data.datasets[0]) {
      chart.data.datasets[0].data = values;
      chart.data.datasets[0].borderColor = color;
      chart.data.datasets[0].backgroundColor = `${color}22`;
      chart.data.datasets[0].label = label;
    }
    chart.update('none');
  }, [labels, values, color, label, ready]);

  return (
    <div style={{ height: `${height}px`, position: 'relative' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
