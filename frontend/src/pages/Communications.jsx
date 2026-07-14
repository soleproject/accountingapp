import GenericList from "./GenericList";
export default function Communications() {
  return <GenericList path="communications" title="Communications"
    fields={[
      { k: "subject", l: "Subject" },
      { k: "from", l: "From" },
      { k: "channel", l: "Channel" },
      { k: "date", l: "Date", t: "date" },
    ]}
  />;
}
