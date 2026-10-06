import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/ui/menubar";
import { useMenuSections } from "./menu-context";

function renderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items.map((item, index) => {
    if (item.kind === "separator") {
      return <MenubarSeparator key={item.id || `sep-${index}`} />;
    }
    if (item.kind === "label") {
      return (
        <MenubarGroup key={item.id || `label-${index}`}>
          <MenubarLabel>{item.label}</MenubarLabel>
        </MenubarGroup>
      );
    }
    if (item.kind === "checkbox") {
      return (
        <MenubarCheckboxItem
          key={item.id}
          checked={Boolean(item.checked)}
          disabled={item.disabled}
          onCheckedChange={() => item.onSelect?.()}
        >
          {item.label}
          {item.shortcut ? (
            <MenubarShortcut>{item.shortcut}</MenubarShortcut>
          ) : null}
        </MenubarCheckboxItem>
      );
    }
    return (
      <MenubarItem
        key={item.id}
        disabled={item.disabled}
        variant={item.variant}
        onClick={() => item.onSelect?.()}
      >
        {item.label}
        {item.shortcut ? (
          <MenubarShortcut>{item.shortcut}</MenubarShortcut>
        ) : null}
      </MenubarItem>
    );
  });
}

export function AppMenubar() {
  const sections = useMenuSections();
  const fileItems = renderItems(sections.file);
  const editItems = renderItems(sections.edit);
  const appViewItems = renderItems(sections.view);
  const extraItems = renderItems(sections.extra?.items);
  const hasView = Boolean(appViewItems || sections.viewContent);
  return (
    <Menubar
      aria-label="Application menu"
      className="h-8 w-full shrink-0 justify-start gap-0 border-0 bg-background px-1 rule-b"
    >
      {fileItems ? (
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent align="start">{fileItems}</MenubarContent>
        </MenubarMenu>
      ) : null}
      {editItems ? (
        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent align="start">{editItems}</MenubarContent>
        </MenubarMenu>
      ) : null}
      {Array.isArray(sections.menus)
        ? sections.menus.map((menu) => (
            <MenubarMenu key={menu.id || menu.label}>
              <MenubarTrigger>{menu.label}</MenubarTrigger>
              <MenubarContent align="start">{menu.content}</MenubarContent>
            </MenubarMenu>
          ))
        : null}
      {extraItems && sections.extra?.label ? (
        <MenubarMenu>
          <MenubarTrigger>{sections.extra.label}</MenubarTrigger>
          <MenubarContent align="start">{extraItems}</MenubarContent>
        </MenubarMenu>
      ) : null}
      {hasView ? (
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent align="start" className="w-64">
            {appViewItems}
            {appViewItems && sections.viewContent ? <MenubarSeparator /> : null}
            {sections.viewContent}
          </MenubarContent>
        </MenubarMenu>
      ) : null}
    </Menubar>
  );
}
