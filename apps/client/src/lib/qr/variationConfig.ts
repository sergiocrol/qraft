import { QRGenerator } from './generator';
import type { QRGeneratorOptions } from './generator';
import type { QRVariation } from './types';
import { QR_DEFAULTS } from '@/lib/constants';

export interface QRVariationConfig {
  type: QRVariation['type'];
  description: string;
  options: QRGeneratorOptions;
  generator: (text: string, options: QRGeneratorOptions) => Promise<QRVariation>;
}

const baseOptions = {
  width: QR_DEFAULTS.WIDTH,
  color: { dark: QR_DEFAULTS.COLOR_DARK, light: QR_DEFAULTS.COLOR_LIGHT },
} as const;

export const QR_VARIATION_CONFIGS: readonly QRVariationConfig[] = [
  {
    type: 'standard',
    description: 'Standard QR',
    options: {
      ...baseOptions,
      margin: 5,
      errorCorrectionLevel: 'H',
    },
    generator: QRGenerator.standardQR,
  },
  {
    type: 'with-space',
    description: 'QR with center space (react-qrcode-logo)',
    options: {
      ...baseOptions,
      margin: 7,
      errorCorrectionLevel: 'H',
    },
    generator: QRGenerator.withSpaceQR,
  },
  {
    type: 'compact',
    description: 'Compact QR',
    options: {
      ...baseOptions,
      margin: 3,
      errorCorrectionLevel: 'M',
    },
    generator: QRGenerator.compactQR,
  },
] as const;
