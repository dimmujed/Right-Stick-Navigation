import {
  ButtonItem,
  Navigation,
  PanelSection,
  PanelSectionRow,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { startNavigation } from "./navigation";
import { FaArrowsAlt } from "react-icons/fa";

type PluginStatus = { enabled: boolean };

const getStatus = callable<[], PluginStatus>("get_status");
const setEnabled = callable<[enabled: boolean], PluginStatus>("set_enabled");

function openKoFi() {
  Navigation.CloseSideMenus();
  Navigation.NavigateToExternalWeb("https://ko-fi.com/jedwhitaker");
}

function Content() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    let mounted = true;
    let reading = false;
    const refresh = async () => {
      if (reading || writing.current) return;
      reading = true;
      const before = generation.current;
      const current = await getStatus().catch(() => null);
      if (current && mounted && before === generation.current) setStatus(current);
      reading = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const toggle = async () => {
    if (!status || writing.current) return;
    writing.current = true;
    generation.current++;
    setBusy(true);
    const current = await setEnabled(!status.enabled).catch(() => null);
    if (current) setStatus(current);
    writing.current = false;
    setBusy(false);
  };

  return (
    <PanelSection>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={toggle} disabled={!status || busy}>
          {status?.enabled === false ? "Enable" : "Disable"}
        </ButtonItem>
      </PanelSectionRow>
      <div style={{ paddingTop: "clamp(48px, 16vh, 120px)" }}>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={openKoFi}>
            Tip the dev on Ko-fi
          </ButtonItem>
        </PanelSectionRow>
      </div>
    </PanelSection>
  );
}

export default definePlugin(() => {
  const stopNavigation = startNavigation();
  return {
    onDismount: stopNavigation,
    name: "Right Stick Navigation",
    content: <Content />,
    icon: <FaArrowsAlt />,
  };
});
