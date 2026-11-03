import { redirect } from "next/navigation";

// The Auto algo trading page is the app's home; the old dashboard was removed.
export default function Home() {
  redirect("/execution");
}
