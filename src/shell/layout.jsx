import { MenuProvider } from "./menu-context";
import { AppMenubar } from "./menubar";

export function AppLayout({
  title,
  description,
  actions,
  showHeader = true,
  children,
}) {
  return (
    <MenuProvider>
      <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <AppMenubar />
        {showHeader ? (
          <header className="flex h-12 shrink-0 items-center justify-between gap-4 px-3 rule-b">
            <div className="min-w-0">
              <h1 className="truncate">{title}</h1>
              {description ? (
                <p className="truncate text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {actions ? (
              <div className="flex items-center gap-2">{actions}</div>
            ) : null}
          </header>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </MenuProvider>
  );
}
