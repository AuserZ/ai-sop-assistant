import type { Metadata } from "next";
import { UserManagementPanel } from "@/components/users/user-management-panel";

export const metadata: Metadata = { title: "User Management | AI SOP Assistant" };

export default function UsersPage() {
  return <UserManagementPanel />;
}
