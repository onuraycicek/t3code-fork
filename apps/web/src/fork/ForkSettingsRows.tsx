import { SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { useForkPrefsStore } from "./forkPrefsStore";

/** Fork settings, rendered inside the General settings panel. */
export function ForkSettingsRows() {
  const grouping = useForkPrefsStore((state) => state.sidebarProjectGroupingEnabled);
  const setGrouping = useForkPrefsStore((state) => state.setSidebarProjectGroupingEnabled);
  return (
    <SettingsRow
      title="Group threads by project"
      description="List active threads under a header for each project, five at a time. Pinned, working, snoozed, and settled threads stay where they are."
      control={
        <Switch
          checked={grouping}
          onCheckedChange={(checked) => setGrouping(Boolean(checked))}
          aria-label="Group threads by project"
        />
      }
    />
  );
}
