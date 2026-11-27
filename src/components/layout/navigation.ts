export type PrimaryMenuKey = "chat" | "documents" | "users";
export type NavigationRole = "ADMIN" | "STAFF";
export type NavigationIconName = "message-square" | "file-text" | "users";

export type NavigationItem = {
  readonly key: PrimaryMenuKey;
  readonly label: string;
  readonly href: string;
  readonly iconName: NavigationIconName;
};

const chatItem: NavigationItem = {
  key: "chat",
  label: "Chat",
  href: "/chat",
  iconName: "message-square",
};

const documentsItem: NavigationItem = {
  key: "documents",
  label: "List Document SOP",
  href: "/documents",
  iconName: "file-text",
};

const usersItem: NavigationItem = {
  key: "users",
  label: "User Management",
  href: "/users",
  iconName: "users",
};

const staffNavigation: readonly NavigationItem[] = [chatItem, documentsItem];
const adminNavigation: readonly NavigationItem[] = [chatItem, documentsItem, usersItem];

export function getNavigationItems(role: NavigationRole): readonly NavigationItem[] {
  return role === "ADMIN" ? adminNavigation : staffNavigation;
}

export function resolveActiveMenu(pathname: string): PrimaryMenuKey | null {
  const normalized = pathname.trim().replace(/\/+$/, "") || "/";
  if (normalized === "/chat" || normalized.startsWith("/chat/")) {
    return "chat";
  }
  if (normalized === "/documents" || normalized.startsWith("/documents/")) {
    return "documents";
  }
  if (normalized === "/users" || normalized.startsWith("/users/")) {
    return "users";
  }
  return null;
}

export function getMonogramInitials(name: string): string {
  const tokens = name
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return `${tokens[0][0]}${tokens[tokens.length - 1][0]}`.toUpperCase();
}
