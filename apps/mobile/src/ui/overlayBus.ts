/** Tiny imperative bus so any code (not just components) can open the action sheet or a toast. */
export type SheetAction = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

export type SheetRequest = {
  title?: string;
  message?: string;
  actions: SheetAction[];
};

type SheetListener = (req: SheetRequest | null) => void;
type ToastListener = (msg: string) => void;

const sheetListeners = new Set<SheetListener>();
const toastListeners = new Set<ToastListener>();

export function showActionSheet(req: SheetRequest) {
  sheetListeners.forEach((l) => l(req));
}

export function subscribeActionSheet(l: SheetListener): () => void {
  sheetListeners.add(l);
  return () => {
    sheetListeners.delete(l);
  };
}

export function showToast(msg: string) {
  toastListeners.forEach((l) => l(msg));
}

export function subscribeToast(l: ToastListener): () => void {
  toastListeners.add(l);
  return () => {
    toastListeners.delete(l);
  };
}
