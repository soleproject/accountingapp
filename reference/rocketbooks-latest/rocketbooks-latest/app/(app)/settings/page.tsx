import { SettingsClient } from './_components/SettingsClient';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Profile and organization details</p>
      </header>
      <SettingsClient />
    </div>
  );
}
