import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

const DialogContext = createContext(null);

function fallbackConfirm(options) {
  if (typeof window === "undefined") return Promise.resolve(false);
  return Promise.resolve(
    window.confirm(
      [options.title, options.description].filter(Boolean).join("\n\n"),
    ),
  );
}

function fallbackPrompt(options) {
  if (typeof window === "undefined") return Promise.resolve(null);
  return Promise.resolve(
    window.prompt(options.title, options.defaultValue || "")?.trim() || null,
  );
}

export function DialogProvider({ children }) {
  const [pending, setPending] = useState(null);
  const [promptValue, setPromptValue] = useState("");
  const settle = useCallback(
    (value) => {
      setPending((current) => {
        if (!current) return null;
        if (current.kind === "confirm") current.resolve(Boolean(value));
        else current.resolve(typeof value === "string" ? value : null);
        return null;
      });
    },
    [setPending],
  );
  const api = useMemo(
    () => ({
      confirm(options) {
        return new Promise((resolve) => {
          setPending({ ...options, kind: "confirm", resolve });
        });
      },
      prompt(options) {
        return new Promise((resolve) => {
          setPromptValue(options.defaultValue || "");
          setPending({ ...options, kind: "prompt", resolve });
        });
      },
    }),
    [],
  );
  const confirmLabel =
    pending?.confirmLabel ||
    (pending?.tone === "destructive" ? "Delete" : "OK");
  const cancelLabel = pending?.cancelLabel || "Cancel";
  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) settle(null);
        }}
      >
        <DialogContent className="w-[min(420px,calc(100vw-2rem))]">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) return;
              settle(pending.kind === "prompt" ? promptValue.trim() : true);
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>{pending?.title || "Confirm action"}</DialogTitle>
              {pending?.description ? (
                <DialogDescription>{pending.description}</DialogDescription>
              ) : null}
            </DialogHeader>

            {pending?.kind === "prompt" ? (
              <label className="grid gap-2">
                <span className="text-foreground">
                  {pending.inputLabel || "Value"}
                </span>
                <Input
                  autoFocus
                  value={promptValue}
                  onChange={(event) => setPromptValue(event.target.value)}
                  placeholder={pending.placeholder}
                />
              </label>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => settle(null)}
              >
                {cancelLabel}
              </Button>
              <Button
                type="submit"
                variant={
                  pending?.tone === "destructive" ? "destructive" : "default"
                }
              >
                {confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DialogContext.Provider>
  );
}

export function useAppDialog() {
  const context = useContext(DialogContext);
  return context || { confirm: fallbackConfirm, prompt: fallbackPrompt };
}
