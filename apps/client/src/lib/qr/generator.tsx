import { createRoot } from 'react-dom/client';
import { QRCode as QRCodeLogo } from 'react-qrcode-logo';
import QRCode from 'qrcode';

import type { QRVariation } from './types';

export interface QRGeneratorOptions {
  width?: number;
  margin?: number;
  color?: {
    dark?: string;
    light?: string;
  };
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

export class QRGenerator {
  static async generateDataURL(text: string, options: QRGeneratorOptions = {}): Promise<string> {
    const defaultOptions: QRGeneratorOptions = {
      width: 256,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'M',
    };

    const mergedOptions = { ...defaultOptions, ...options };

    try {
      return await QRCode.toDataURL(text, mergedOptions);
    } catch (error) {
      console.error('Error generating QR code:', error);
      throw new Error('Failed to generate QR code');
    }
  }

  static async generateSVG(text: string, options: QRGeneratorOptions = {}): Promise<string> {
    try {
      return await QRCode.toString(text, {
        type: 'svg',
        ...options,
      });
    } catch (error) {
      console.error('Error generating QR SVG:', error);
      throw new Error('Failed to generate QR SVG');
    }
  }

  static async generateCanvas(
    text: string,
    canvas: HTMLCanvasElement,
    options: QRGeneratorOptions = {}
  ): Promise<void> {
    try {
      await QRCode.toCanvas(canvas, text, options);
    } catch (error) {
      console.error('Error generating QR canvas:', error);
      throw new Error('Failed to generate QR canvas');
    }
  }

  static async standardQR(text: string, options: QRGeneratorOptions = {}): Promise<QRVariation> {
    try {
      const standardQR = await QRCode.toDataURL(text, options);

      return {
        dataUrl: standardQR,
        type: 'standard',
        description: 'Standard QR',
      };
    } catch (error) {
      console.error('Error generating Standard QR:', error);
      throw new Error('Failed to generate Standard QR');
    }
  }

  static withSpaceQR(text: string, options: QRGeneratorOptions = {}): Promise<QRVariation> {
    return new Promise((resolve, reject) => {
      try {
        const tempDiv = document.createElement('div');
        const root = createRoot(tempDiv);
        let qrCodeRef: any = null;

        const width = options.width || 1024;
        const quietZone = options.margin || 7;
        const darkColor = options.color?.dark || '#000000';
        const lightColor = options.color?.light || '#FFFFFF';
        const errorLevel = options.errorCorrectionLevel || 'H';

        const logoSize = width * 0.2;
        const emptyLogo =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

        const renderAndCapture = () => {
          const canvas = tempDiv.querySelector('canvas');
          if (canvas) {
            const dataUrl = canvas.toDataURL('image/png');
            root.unmount();
            resolve({
              dataUrl: dataUrl,
              type: 'with-space',
              description: 'QR with center space (react-qrcode-logo)',
            });
          } else {
            root.unmount();
            reject(new Error('Failed to get QR code canvas reference.'));
          }
        };

        let hasResolved = false;
        const handleLoad = () => {
          if (!hasResolved) {
            hasResolved = true;
            renderAndCapture();
          }
        };

        setTimeout(() => {
          if (!hasResolved) {
            console.warn('QR code generation timeout reached, attempting to capture.');
            hasResolved = true;
            renderAndCapture();
          }
        }, 500);

        root.render(
          <QRCodeLogo
            value={text}
            size={width}
            ecLevel={errorLevel}
            quietZone={120}
            qrStyle="squares"
            fgColor={darkColor}
            bgColor={lightColor}
            logoImage={emptyLogo}
            logoWidth={logoSize}
            logoHeight={logoSize}
            removeQrCodeBehindLogo={true}
            logoOnLoad={handleLoad}
          />
        );
      } catch (error) {
        console.error('Error generating withSpace QR with react-qrcode-logo:', error);
        reject(new Error('Failed to generate withSpace QR'));
      }
    });
  }

  static async compactQR(text: string, options: QRGeneratorOptions = {}): Promise<QRVariation> {
    try {
      const compactQR = await QRCode.toDataURL(text, options);

      return {
        dataUrl: compactQR,
        type: 'compact',
        description: 'Compact QR',
      };
    } catch (error) {
      console.error('Error generating Compact QR:', error);
      throw new Error('Failed to generate Compact QR');
    }
  }
}
