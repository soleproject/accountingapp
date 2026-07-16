import { ReceiptUploadForm } from '../_components/ReceiptUploadForm';

export default function ReceiptUploadPage() {
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Upload receipt</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          PDF, JPG, or PNG up to 10 MB. We&apos;ll extract vendor, total, date, and line items via Veryfi OCR.
        </p>
      </header>
      <ReceiptUploadForm />
    </div>
  );
}
