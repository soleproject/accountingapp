import { useEffect, useRef, useState } from "react";
import { Bold, Underline, Italic, Strikethrough, Link, Image, ListOrdered, List, Code } from "lucide-react";

const TOOLS = [
  ["bold", Bold], ["underline", Underline], ["italic", Italic], ["strikeThrough", Strikethrough], null,
  ["createLink", Link], ["insertImage", Image], null,
  ["insertOrderedList", ListOrdered], ["insertUnorderedList", List], null, ["code", Code],
];

export const RichNotes = ({ value, onChange, testId = "practice-rich-notes" }) => {
  const [open, setOpen] = useState(!!value);
  const ref = useRef(null);

  useEffect(() => {
    if (open && ref.current && ref.current.innerHTML !== (value || "")) ref.current.innerHTML = value || "";
  }, [open, value]);

  const run = (cmd) => {
    if (cmd === "createLink" || cmd === "insertImage") {
      const url = window.prompt(cmd === "createLink" ? "Link URL" : "Image URL");
      if (url) document.execCommand(cmd, false, url);
    } else if (cmd === "code") {
      document.execCommand("formatBlock", false, "pre");
    } else {
      document.execCommand(cmd, false, null);
    }
    ref.current?.focus();
    onChange(ref.current?.innerHTML || "");
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-testid={`${testId}-collapsed`}
              className="w-full h-10 rounded border border-slate-300 px-3 text-left text-[15px] text-slate-400 bg-white">Add Notes...</button>
    );
  }
  return (
    <div className="rounded border border-slate-300 bg-white" data-testid={testId}>
      <div className="flex items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
        {TOOLS.map((t, i) => {
          if (t === null) return <span key={i} className="mx-1 h-5 w-px bg-slate-300" />;
          const [cmd, Icon] = t;
          return (
            <button key={cmd} type="button" onMouseDown={e => e.preventDefault()} onClick={() => run(cmd)} data-testid={`${testId}-${cmd.toLowerCase()}`}
                    className="h-7 w-7 grid place-items-center rounded hover:bg-slate-200 text-slate-700"><Icon size={14} /></button>
          );
        })}
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning autoFocus data-testid={`${testId}-editor`}
           onInput={() => onChange(ref.current?.innerHTML || "")}
           className="min-h-[200px] px-3 py-2 text-[15px] text-slate-700 outline-none" />
    </div>
  );
};
