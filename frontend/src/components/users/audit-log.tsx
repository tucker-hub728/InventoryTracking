'use client';

import * as React from 'react';
import { Download } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermission } from '@/hooks/use-permission';
import { toast } from '@/components/ui/sonner';
import { mockData } from '@/lib/mock-data';

const SEVERITY_TONE = {
  info: 'accent',
  warning: 'warning',
  danger: 'danger',
} as const;

export function AuditLog() {
  const canExport = usePermission('audit', 'export');
  const events = mockData.auditEvents;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Recent audit events</div>
          <div className="text-xs text-text-3">
            Read-only · {events.length} events shown · retained for 10 years
          </div>
        </div>
        {canExport && (
          <Button size="sm" onClick={() => toast.success('Export ready', { description: 'Audit CSV downloaded' })}>
            <Download size={13} /> Export
          </Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[170px]">Timestamp</TableHead>
            <TableHead className="w-[160px]">User</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
            <TableHead className="w-[100px]">Severity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e, i) => (
            <TableRow key={i}>
              <TableCell className="font-mono text-xs text-text-2">{e.ts}</TableCell>
              <TableCell className="text-sm">{e.user}</TableCell>
              <TableCell>
                <div className="text-sm">{e.action}</div>
                <div className="text-xs text-text-3">{e.detail}</div>
              </TableCell>
              <TableCell className="font-mono text-xs">{e.target}</TableCell>
              <TableCell>
                <Badge tone={SEVERITY_TONE[e.severity]} dot>
                  {e.severity}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
