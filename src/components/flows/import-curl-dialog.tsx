'use client'

import { useState } from 'react'
import { TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { parseCurl, type ParsedCurl } from '@/lib/flows/curl'

export function ImportCurlDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (parsed: ParsedCurl) => void
}) {
  const [command, setCommand] = useState('')

  const handleImport = () => {
    const parsed = parseCurl(command)
    if (!parsed.url) {
      toast.error('Could not find a URL in that command.')
      return
    }
    onImport(parsed)
    toast.success('Imported request from cURL.')
    setCommand('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-horizon-50 text-horizon-700">
              <TerminalSquare className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle>Import cURL</DialogTitle>
              <DialogDescription className="mt-1">
                Paste a cURL command to fill in the method, URL, headers, and body. Credentials
                (<code>-u</code>) are ignored — set those up under Authentication.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <Textarea
          rows={8}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={"curl https://api.example.com/v1/items \\\n  -H 'Authorization: Bearer …' \\\n  -d '{\"name\":\"value\"}'"}
          className="font-mono text-xs"
          aria-label="cURL command"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleImport} disabled={!command.trim()}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
