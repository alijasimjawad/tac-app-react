-- Migration 005: Backfill part_number for GR-202608-00003 / ARGA scan log
--
-- Root cause: GR-202608-00003 was saved between commits d194d71 and 57c968d.
-- At that point the scan log INSERT did not include the part_number field, so
-- receiving_scan_log.part_number was stored as NULL even though the PN
-- (474800A.102) was correctly captured in goods_receipt_items.part_number
-- and item_code_mappings (via learnPnMappings).
--
-- This update targets exactly one row (SN K9241823295) and is guarded by
-- four independent checks. DO NOT execute without reading all guards first.
--
-- SAFETY GUARDS (all must pass or the UPDATE touches 0 rows):
--   1. The scan log row has part_number IS NULL (no double-write)
--   2. The receipt is GR-202608-00003
--   3. The item code is ARGA
--   4. goods_receipt_items confirms PN = '474800A.102' for ARGA in this receipt
--
-- Run this in the Supabase SQL editor. Wrap in BEGIN/ROLLBACK first to preview.

UPDATE receiving_scan_log rsl
SET    part_number = '474800A.102'
WHERE  rsl.part_number IS NULL
  AND  rsl.serial_number = 'K9241823295'
  AND  EXISTS (
         SELECT 1
         FROM   goods_receipts gr
         WHERE  gr.id = rsl.goods_receipt_id
           AND  gr.receipt_number = 'GR-202608-00003'
       )
  AND  EXISTS (
         SELECT 1
         FROM   inventory_items ii
         WHERE  ii.id = rsl.inventory_item_id
           AND  ii.item_code = 'ARGA'
       )
  AND  EXISTS (
         SELECT 1
         FROM   goods_receipt_items gri
         JOIN   goods_receipts gr ON gr.id = gri.goods_receipt_id
         WHERE  gri.inventory_item_id = rsl.inventory_item_id
           AND  gr.receipt_number     = 'GR-202608-00003'
           AND  gri.part_number       = '474800A.102'
       );

-- Expected result: UPDATE 1
-- If UPDATE 0: the row was already fixed or the guards did not match — investigate before retrying.
