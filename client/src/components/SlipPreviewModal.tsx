import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface SlipPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  slipUrl: string;
  slipAlt?: string;
}

export function SlipPreviewModal({ isOpen, onClose, slipUrl, slipAlt = "Payment slip" }: SlipPreviewModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Payment Slip Preview</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          <img
            src={slipUrl}
            alt={slipAlt}
            className="max-w-full max-h-96 rounded border border-slate-200"
          />
          <div className="flex gap-2 w-full">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => window.open(slipUrl, "_blank")}
            >
              Open in New Tab
            </Button>
            <Button variant="outline" className="flex-1" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
