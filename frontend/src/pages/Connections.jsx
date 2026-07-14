import GenericList from "./GenericList";
export default function Connections() {
  return <GenericList path="connections" title="Connections"
    fields={[
      { k: "provider", l: "Provider" },
      { k: "kind", l: "Type" },
      { k: "status", l: "Status" },
      { k: "notes", l: "Notes" },
    ]}
  />;
}
