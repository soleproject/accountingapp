import ReportView from "./ReportView";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

export default function GeneralLedger() {
  const nav = useNavigate();
  useEffect(() => { nav("/reports/general-ledger", { replace: true }); }, [nav]);
  return null;
}
