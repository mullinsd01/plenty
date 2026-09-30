import { requireHousehold } from "@/server/auth/context";

export default async function HomePage() {
  const ctx = await requireHousehold();
  return <h1 className="text-2xl font-semibold">Hello {ctx.user.displayName}</h1>;
}
