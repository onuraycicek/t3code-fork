import { SettingsRow } from "../components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { useForkPrefsStore } from "./forkPrefsStore";
import { hasKeepAwakeBridge } from "./KeepAwakeSync";
import { isKeepAwakeMode, KEEP_AWAKE_MODES } from "./keepAwake.logic";
import { useKeepAwakeRuntimeStore } from "./keepAwakeStore";

/** Fork settings, rendered inside the General settings panel. */
export function ForkSettingsRows() {
  const grouping = useForkPrefsStore((state) => state.sidebarProjectGroupingEnabled);
  const setGrouping = useForkPrefsStore((state) => state.setSidebarProjectGroupingEnabled);
  return (
    <>
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
      <KeepAwakeRow />
    </>
  );
}

function KeepAwakeRow() {
  const mode = useForkPrefsStore((state) => state.keepAwakeMode);
  const setMode = useForkPrefsStore((state) => state.setKeepAwakeMode);
  const blockerActive = useKeepAwakeRuntimeStore((state) => state.blockerActive);
  const desktop = hasKeepAwakeBridge();
  const label = KEEP_AWAKE_MODES.find((entry) => entry.value === mode)?.label ?? "Off";
  return (
    <SettingsRow
      title="Keep awake"
      description="Stops the Mac from sleeping (the display may still turn off). Only applies to the desktop app."
      status={
        desktop && blockerActive ? (
          <span className="text-success">Keeping this Mac awake now</span>
        ) : !desktop ? (
          <span>Not available in the browser</span>
        ) : null
      }
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            if (isKeepAwakeMode(value)) setMode(value);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Keep awake">
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {KEEP_AWAKE_MODES.map((entry) => (
              <SelectItem hideIndicator key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
