import { useBlockchain } from '@/stores';
import numeral from 'numeral';

const chainStore = useBlockchain()

// 👉 Utilities for color conversions
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean.length === 3 ? clean.split('').map(x => x + x).join('') : clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (0 <= h && h < 60) { r = c; g = x; b = 0; }
  else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
  else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
  else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
  else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toLowerCase();
}

// 👉 Generate bright, contrasting palette based on theme primary color
export function getContrastingBarPalette(theme: string, count: number): string[] {
  const primaryHex = (themeColors(theme).colors.primary || '#666CFF').toLowerCase();
  const { r, g, b } = hexToRgb(primaryHex);
  const baseHsl = rgbToHsl(r, g, b);

  // Start from the complementary hue and distribute around the wheel using golden angle for separation
  let startHue = (baseHsl.h + 180) % 360;
  const goldenAngle = 137.508; // degrees

  // Saturation/lightness tuned for strong contrast in both themes
  const isDark = themeColors(theme).dark;
  const sat = 88; // high saturation for vivid colors
  const light = isDark ? 62 : 48; // a bit lighter on dark theme, slightly darker on light theme for readability

  const palette: string[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    const hue = (startHue + i * goldenAngle) % 360;
    palette.push(hslToHex(hue, sat, light));
  }

  // Ensure uniqueness and avoid matching primary exactly
  const unique = Array.from(new Set(palette.map(x => x.toLowerCase())));
  if (unique.length === 0) unique.push('#ff4081');
  return unique.slice(0, Math.max(1, count));
}

const themeColors = (theme: string) => {
  if (theme === 'light') {
    return {
      dark: false,
      colors: {
        background: '#F7F7F9',
        surface: '#FFFFFF',
        'surface-variant': '#424242',
        'on-surface-variant': '#EEEEEE',
        primary: chainStore.current?.themeColor || '#666CFF',
        'primary-darken-1': '#3700B3',
        secondary: '#6D788D',
        'secondary-darken-1': '#018786',
        error: '#FF4D49',
        info: '#26C6F9',
        success: '#72E128',
        warning: '#FDB528',
        'on-primary': '#fff',
        'on-secondary': '#fff',
        'on-success': '#fff',
        'on-info': '#fff',
        'on-warning': '#fff',
        'on-background': '#4c4e64',
        'on-surface': '#4c4e64',
        'perfect-scrollbar-thumb': '#DBDADE',
        'snackbar-background': '#212121',
        'tooltip-background': '#262732',
        'alert-background': '#F7F7F9',
        'grey-50': '#FAFAFA',
        'grey-100': '#F4F5FA',
        'grey-200': '#F5F5F7',
        'grey-300': '#E0E0E0',
        'grey-400': '#BDBDBD',
        'grey-500': '#9E9E9E',
        'grey-600': '#757575',
        'grey-700': '#616161',
        'grey-800': '#424242',
        'grey-900': '#212121',
        'on-primary-darken-1': '#fff',
        'on-secondary-darken-1': '#fff',
        'on-error': '#fff',
        'on-perfect-scrollbar-thumb': '#000',
        'on-snackbar-background': '#fff',
        'on-tooltip-background': '#fff',
        'on-alert-background': '#000',
        'on-grey-50': '#000',
        'on-grey-100': '#000',
        'on-grey-200': '#000',
        'on-grey-300': '#000',
        'on-grey-400': '#000',
        'on-grey-500': '#fff',
        'on-grey-600': '#fff',
        'on-grey-700': '#fff',
        'on-grey-800': '#fff',
        'on-grey-900': '#fff',
      },
      variables: {
        'border-color': '#4c4e64',
        'border-opacity': 0.12,
        'high-emphasis-opacity': 0.87,
        'medium-emphasis-opacity': 0.6,
        'disabled-opacity': 0.38,
        'idle-opacity': 0.04,
        'hover-opacity': 0.05,
        'focus-opacity': 0.12,
        'selected-opacity': 0.08,
        'activated-opacity': 0.12,
        'pressed-opacity': 0.12,
        'dragged-opacity': 0.08,
        'theme-kbd': '#212529',
        'theme-on-kbd': '#FFFFFF',
        'theme-code': '#F5F5F5',
        'theme-on-code': '#000000',
        'code-color': '#d400ff',
        'overlay-scrim-background': '#4C4E64',
        'overlay-scrim-opacity': 0.5,
        'shadow-key-umbra-opacity': 'rgba(var(--v-theme-on-surface), 0.08)',
        'shadow-key-penumbra-opacity': 'rgba(var(--v-theme-on-surface), 0.05)',
        'shadow-key-ambient-opacity': 'rgba(var(--v-theme-on-surface), 0.03)',
      },
    };
  }
  return {
    dark: true,
    colors: {
      background: '#282A42',
      surface: '#30334E',
      'surface-variant': '#BDBDBD',
      'on-surface-variant': '#424242',
      primary: chainStore.current?.themeColor || '#666CFF',
      'primary-darken-1': '#3700B3',
      secondary: '#6D788D',
      'secondary-darken-1': '#03DAC5',
      error: '#FF4D49',
      info: '#26C6F9',
      success: '#72E128',
      warning: '#FDB528',
      'on-primary': '#fff',
      'on-secondary': '#fff',
      'on-success': '#fff',
      'on-info': '#fff',
      'on-warning': '#fff',
      'on-background': '#eaeaff',
      'on-surface': '#eaeaff',
      'perfect-scrollbar-thumb': '#4A5072',
      'snackbar-background': '#F5F5F5',
      'on-snackbar-background': '#30334E',
      'tooltip-background': '#464A65',
      'alert-background': '#282A42',
      'grey-50': '#2A2E42',
      'grey-100': '#41435c',
      'grey-200': '#3A3E5B',
      'grey-300': '#5E6692',
      'grey-400': '#7983BB',
      'grey-500': '#8692D0',
      'grey-600': '#AAB3DE',
      'grey-700': '#B6BEE3',
      'grey-800': '#CFD3EC',
      'grey-900': '#E7E9F6',
      'on-primary-darken-1': '#fff',
      'on-secondary-darken-1': '#000',
      'on-error': '#fff',
      'on-perfect-scrollbar-thumb': '#fff',
      'on-tooltip-background': '#fff',
      'on-alert-background': '#fff',
      'on-grey-50': '#fff',
      'on-grey-100': '#fff',
      'on-grey-200': '#fff',
      'on-grey-300': '#fff',
      'on-grey-400': '#fff',
      'on-grey-500': '#fff',
      'on-grey-600': '#000',
      'on-grey-700': '#000',
      'on-grey-800': '#000',
      'on-grey-900': '#000',
    },
    variables: {
      'border-color': '#eaeaff',
      'border-opacity': 0.12,
      'high-emphasis-opacity': 0.87,
      'medium-emphasis-opacity': 0.6,
      'disabled-opacity': 0.38,
      'idle-opacity': 0.1,
      'hover-opacity': 0.05,
      'focus-opacity': 0.12,
      'selected-opacity': 0.08,
      'activated-opacity': 0.12,
      'pressed-opacity': 0.16,
      'dragged-opacity': 0.08,
      'theme-kbd': '#212529',
      'theme-on-kbd': '#FFFFFF',
      'theme-code': '#343434',
      'theme-on-code': '#CCCCCC',
      'code-color': '#d400ff',
      'overlay-scrim-background': '#101121',
      'overlay-scrim-opacity': 0.6,
      'shadow-key-umbra-opacity': 'rgba(20, 21, 33, 0.08)',
      'shadow-key-penumbra-opacity': 'rgba(20, 21, 33, 0.05)',
      'shadow-key-ambient-opacity': 'rgba(20, 21, 33, 0.03)',
    },
  };
};
// 👉 Colors variables
export const colorVariables = (theme: string) => {
  if (theme === 'light') {
    return {
      themeSecondaryTextColor: 'rgba(76,78,100,0.6)',
      themeDisabledTextColor: 'rgba(76,78,100,0.38)',
      themeBorderColor: 'rgba(76,78,100,0.12)',
      themePrimaryTextColor: 'rgba(76,78,100,0.87)',
    };
  }
  return {
    themeSecondaryTextColor: 'rgba(234,234,255,0.6)',
    themeDisabledTextColor: 'rgba(234,234,255,0.38)',
    themeBorderColor: 'rgba(234,234,255,0.12)',
    themePrimaryTextColor: 'rgba(234,234,255,0.87)',
  };
};
/// Price Chart config
export const getMarketPriceChartConfig = (
  theme: string,
  categories: string[]
) => {
  const { themeSecondaryTextColor, themeBorderColor, themeDisabledTextColor } =
    colorVariables(theme);

  return {
    chart: {
      redrawOnParentResize: true,
      width: '100%',
      parentHeightOffset: 0,
      toolbar: { show: false },
    },
    tooltip: {
      theme: 'dark',
      shared: false,
    },
    dataLabels: { enabled: false },
    stroke: {
      // show: false,
      curve: 'smooth',
      width: 1.5,
    },
    legend: {
      position: 'top',
      horizontalAlign: 'left',

      labels: { colors: themeSecondaryTextColor },
      markers: {
        offsetY: 1,
        offsetX: -3,
      },
      itemMargin: {
        vertical: 3,
        horizontal: 10,
      },
    },

    colors: [themeColors(theme).colors.primary],
    fill: {
      opacity: 0.5,
      type: 'gradient',
    },
    grid: {
      show: true,
      borderColor: themeBorderColor,
      xaxis: {
        lines: { show: true },
      },
    },
    yaxis: {
      labels: {
        style: { colors: themeDisabledTextColor },
        formatter: function (value: string) {
          const pattern = Number(value) > 0.01 ? '0.0[0]a' : '0.00[000]';
          return numeral(value).format(pattern);
        },
      },
    },
    xaxis: {
      type: 'datetime',
      axisBorder: { show: false },

      axisTicks: { color: themeBorderColor },
      crosshairs: {
        stroke: { color: themeBorderColor },
      },
      labels: {
        style: { colors: themeDisabledTextColor },
      },
      categories,
    },
  };
};

// const donutColors = Array.from({length: 19}, () => (`#${Math.floor(Math.random()*16777215+100000).toString(16)}`))
const donutColors = ["#bbe81a", "#ff5f0b", "#43ebef", "#1999e5", "#230b2c", "#628be8", "#aa5343", "#c9fa89", "#e88ea8", "#72e4a2", "#38cd87", "#515e13", "#7bf8f5", "#83dd6e", "#e8b203", "#7d11d5", "#3e4927", "#f303e2", "#249493", "#50e5e6", "#11deb2", "#a2f9c7", "#2a7bdc", "#47383a", "#226da4", "#966319", "#1bdf99", "#f3ab0c", "#961f50", "#832efd", "#875287", "#4bebe7", "#1d3d2e", "#9caea4", "#2772f5", "#938bf1", "#6228a5", "#24fea5", "#c9bbc8", "#e27225", "#54bd9f", "#babb2d", "#bcf591", "#803b36", "#124f03"]


export const getDonutChartConfig = (
  theme: string,
  labels: string[]
) => {
  const { themeSecondaryTextColor, themePrimaryTextColor } =
    colorVariables(theme);

  const base: any = {
    tooltip: { enabled: false },
    stroke: { width: 0 },
    labels,
    colors: donutColors,
    dataLabels: {
      enabled: true,
      formatter: (val: string) => `${parseInt(val, 10)}%`,
    },
    legend: {
      position: 'bottom',
      markers: { offsetX: -3 },
      labels: { colors: themeSecondaryTextColor },
      itemMargin: {
        vertical: 3,
        horizontal: 10,
      },
    },
    plotOptions: {
      pie: {
        expandOnClick: false,
        donut: {
          labels: {
            show: true,
            name: {
              fontSize: '1.5rem',
            },
            value: {
              fontSize: '1.5rem',
              color: themeSecondaryTextColor,
              formatter: (val: string) => numeral(val).format('0,0.[00]'),
            },
            total: {
              show: true,
              fontSize: '1.5rem',
              color: themePrimaryTextColor,
              label: 'Total',
              formatter: (w: any) => numeral(
                (w?.globals?.seriesTotals || []).reduce((a: number, b: number) => a + b, 0)
              ).format('0,0.[00]'),
            },
          },
        },
      },
    },
    responsive: [
      {
        breakpoint: 992,
        options: {
          chart: {
            height: 380,
          },
          legend: {
            position: 'bottom',
          },
        },
      },
      {
        breakpoint: 576,
        options: {
          chart: {
            height: 320,
          },
          plotOptions: {
            pie: {
              donut: {
                labels: {
                  show: true,
                  name: {
                    fontSize: '1rem',
                  },
                  value: {
                    fontSize: '1rem',
                  },
                  total: {
                    fontSize: '1rem',
                  },
                },
              },
            },
          },
        },
      },
    ],
  }
  base['states'] = { normal: { filter: { type: 'none' } }, hover: { filter: { type: 'none' } }, active: { filter: { type: 'none' } } }
  return base
};
