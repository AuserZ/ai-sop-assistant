import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getMonogramInitials,
  getNavigationItems,
  resolveActiveMenu,
} from "../../src/components/layout/navigation";
import {
  buttonClass,
  resolveStatusTone,
  StatusBadge,
  statusToneStyles,
  textLinkBaseClassName,
  textLinkClassName,
  type ButtonSize,
  type ButtonVariant,
} from "../../src/components/ui/primitives";

const emojiPattern = /\p{Extended_Pictographic}/u;

describe("S13 responsive three-menu navigation & Clinical Precision primitives (C1/D1/D5/U1/U4, ADR 20)", () => {
  it("returns strictly 3 top-level menus for ADMIN and 2 menus for STAFF with no 4th menu", () => {
    const adminItems = getNavigationItems("ADMIN");
    expect(adminItems).toHaveLength(3);
    expect(adminItems.map((item) => ({ key: item.key, label: item.label, href: item.href }))).toEqual([
      { key: "chat", label: "Chat", href: "/chat" },
      { key: "documents", label: "List Document SOP", href: "/documents" },
      { key: "users", label: "User Management", href: "/users" },
    ]);

    const staffItems = getNavigationItems("STAFF");
    expect(staffItems).toHaveLength(2);
    expect(staffItems.map((item) => ({ key: item.key, label: item.label, href: item.href }))).toEqual([
      { key: "chat", label: "Chat", href: "/chat" },
      { key: "documents", label: "List Document SOP", href: "/documents" },
    ]);
    expect(staffItems.some((item) => item.href === "/users" || item.key === "users")).toBe(false);
  });

  it("contains zero raw emojis in navigation definitions", () => {
    for (const role of ["ADMIN", "STAFF"] as const) {
      for (const item of getNavigationItems(role)) {
        expect(emojiPattern.test(item.label)).toBe(false);
        expect(emojiPattern.test(item.key)).toBe(false);
        expect(emojiPattern.test(item.iconName)).toBe(false);
      }
    }
  });

  it("maps nested verification routes to documents without introducing a 4th menu", () => {
    expect(resolveActiveMenu("/documents/abc/verify")).toBe("documents");
    expect(resolveActiveMenu("/documents/550e8400-e29b-41d4-a716-446655440000/verify")).toBe("documents");
    expect(resolveActiveMenu("/documents")).toBe("documents");
    expect(resolveActiveMenu("/documents/")).toBe("documents");
    expect(resolveActiveMenu("/chat")).toBe("chat");
    expect(resolveActiveMenu("/chat/")).toBe("chat");
    expect(resolveActiveMenu("/users")).toBe("users");
    expect(resolveActiveMenu("/users/")).toBe("users");
    expect(resolveActiveMenu("/")).toBeNull();
    expect(resolveActiveMenu("/sign-in")).toBeNull();
  });

  it("derives crisp monogram initials for account identicons", () => {
    expect(getMonogramInitials("Synthetic Admin")).toBe("SA");
    expect(getMonogramInitials("Alice Marie Ops")).toBe("AO");
    expect(getMonogramInitials("Operator")).toBe("OP");
    expect(getMonogramInitials("   ")).toBe("?");
  });

  it("pairs semantic status colors with non-empty accessible text labels on StatusBadge", () => {
    expect(resolveStatusTone("ACTIVE")).toBe("active");
    expect(resolveStatusTone("Active")).toBe("active");
    expect(resolveStatusTone("PENDING_VERIFICATION")).toBe("pending");
    expect(resolveStatusTone("Invited")).toBe("pending");
    expect(resolveStatusTone("PROCESSING")).toBe("processing");
    expect(resolveStatusTone("UPLOADED")).toBe("processing");
    expect(resolveStatusTone("FAILED")).toBe("danger");
    expect(resolveStatusTone("REJECTED")).toBe("danger");
    expect(resolveStatusTone("DELETED")).toBe("danger");
    expect(resolveStatusTone("Inactive")).toBe("danger");

    expect(statusToneStyles.active).toContain("#ecfdf5");
    expect(statusToneStyles.active).toContain("#065f46");
    expect(statusToneStyles.pending).toContain("#fffbeb");
    expect(statusToneStyles.pending).toContain("#92400e");
    expect(statusToneStyles.processing).toContain("#eff6ff");
    expect(statusToneStyles.processing).toContain("#1e40af");
    expect(statusToneStyles.danger).toContain("#fef2f2");
    expect(statusToneStyles.danger).toContain("#991b1b");

    const activeHtml = renderToStaticMarkup(createElement(StatusBadge, { label: "ACTIVE" }));
    expect(activeHtml).toContain("ACTIVE");
    expect(activeHtml).toContain("#ecfdf5");
    expect(activeHtml).toContain("#065f46");

    const emptyFallbackHtml = renderToStaticMarkup(createElement(StatusBadge, { label: "   " }));
    expect(emptyFallbackHtml).toContain("Unknown");
  });

  it("keeps buttonClass size tokens mutually exclusive and textLinkBaseClassName free of display utilities", () => {
    const variants: ButtonVariant[] = ["primary", "secondary", "destructive", "ghost"];
    const sizes: ButtonSize[] = ["default", "sm", "compact", "icon"];
    for (const variant of variants) {
      for (const size of sizes) {
        const tokens = buttonClass(variant, size).split(/\s+/);
        const pxTokens = tokens.filter((token) => /^px-/.test(token));
        expect(pxTokens).toHaveLength(1);
        expect(tokens).toContain("min-h-11");
      }
    }
    expect(textLinkBaseClassName.split(/\s+/)).not.toContain("inline-flex");
    expect(textLinkClassName.split(/\s+/)).toContain("inline-flex");
  });
});
