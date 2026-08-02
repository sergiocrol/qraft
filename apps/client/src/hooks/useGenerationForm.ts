import { useReducer } from 'react';

import type { QRVariation } from '@/components/generation/GenerationForm';
import type { QRGenerationRequest } from '@repo/shared-types';

import { FORM_DEFAULTS, DEFAULT_QR_PLACEHOLDER_URL } from '@/lib/constants';

interface GenerationFormState {
  prompt: string;
  qrUrl: string;
  qrVariations: QRVariation[];
  showAdvanced: boolean;
  uploadingQR: boolean;
  uploadError: string | null;
  numImagesPerPrompt: number;
  numInferenceSteps: number;
  guidanceScale: number;
  negativePrompt: string;
  sampler: QRGenerationRequest['sampler'];
  model: QRGenerationRequest['model'];
  controlnetScale1: number;
  controlnetScale2: number;
  guidanceStart1: number;
  guidanceStart2: number;
  guidanceEnd1: number;
  guidanceEnd2: number;
  seed: number | null;
  promptEnhancement: boolean;
  // v2 only. "none" is the sole preset that leaves the prompt alone; the rest
  // wrap it in a style scaffold, which is why this is a choice and not a
  // default (see STYLE_PRESET_OPTIONS).
  stylePreset: QRGenerationRequest['stylePreset'];
}

type FormAction =
  | { type: 'SET_FIELD'; field: keyof GenerationFormState; value: any }
  | { type: 'SET_QR_VARIATIONS'; variations: QRVariation[] }
  | { type: 'SET_UPLOADING'; uploading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'TOGGLE_ADVANCED' }
  | { type: 'RESET_FORM' }
  | { type: 'BATCH_UPDATE'; updates: Partial<GenerationFormState> };

const initialState: GenerationFormState = {
  prompt: '',
  qrUrl: DEFAULT_QR_PLACEHOLDER_URL,
  qrVariations: [],
  showAdvanced: false,
  uploadingQR: false,
  uploadError: null,
  numImagesPerPrompt: FORM_DEFAULTS.numImagesPerPrompt,
  numInferenceSteps: FORM_DEFAULTS.numInferenceSteps,
  guidanceScale: FORM_DEFAULTS.guidanceScale,
  negativePrompt: FORM_DEFAULTS.negativePrompt,
  sampler: FORM_DEFAULTS.sampler,
  model: FORM_DEFAULTS.model,
  controlnetScale1: FORM_DEFAULTS.controlnetScale1,
  controlnetScale2: FORM_DEFAULTS.controlnetScale2,
  guidanceStart1: FORM_DEFAULTS.guidanceStart1,
  guidanceStart2: FORM_DEFAULTS.guidanceStart2,
  guidanceEnd1: FORM_DEFAULTS.guidanceEnd1,
  guidanceEnd2: FORM_DEFAULTS.guidanceEnd2,
  seed: null,
  promptEnhancement: FORM_DEFAULTS.promptEnhancement,
  stylePreset: FORM_DEFAULTS.stylePreset,
};

function generationFormReducer(
  state: GenerationFormState,
  action: FormAction
): GenerationFormState {
  switch (action.type) {
    case 'SET_FIELD':
      return {
        ...state,
        [action.field]: action.value,
      };
    case 'SET_QR_VARIATIONS':
      return {
        ...state,
        qrVariations: action.variations,
        uploadError: null,
      };
    case 'SET_UPLOADING':
      return {
        ...state,
        uploadingQR: action.uploading,
      };
    case 'SET_ERROR':
      return {
        ...state,
        uploadError: action.error,
      };
    case 'TOGGLE_ADVANCED':
      return {
        ...state,
        showAdvanced: !state.showAdvanced,
      };
    case 'RESET_FORM':
      return initialState;
    case 'BATCH_UPDATE':
      return {
        ...state,
        ...action.updates,
      };
    default:
      return state;
  }
}

export const useGenerationForm = () => {
  const [state, dispatch] = useReducer(generationFormReducer, initialState);

  const updateField = <K extends keyof GenerationFormState>(
    field: K,
    value: GenerationFormState[K]
  ) => {
    dispatch({ type: 'SET_FIELD', field, value });
  };

  const setQRVariations = (variations: QRVariation[]) => {
    dispatch({ type: 'SET_QR_VARIATIONS', variations });
  };

  const setUploading = (uploading: boolean) => {
    dispatch({ type: 'SET_UPLOADING', uploading });
  };

  const setError = (error: string | null) => {
    dispatch({ type: 'SET_ERROR', error });
  };

  const toggleAdvanced = () => {
    dispatch({ type: 'TOGGLE_ADVANCED' });
  };

  const resetForm = () => {
    dispatch({ type: 'RESET_FORM' });
  };

  const batchUpdate = (updates: Partial<GenerationFormState>) => {
    dispatch({ type: 'BATCH_UPDATE', updates });
  };

  return {
    state,
    updateField,
    setQRVariations,
    setUploading,
    setError,
    toggleAdvanced,
    resetForm,
    batchUpdate,
  };
};
