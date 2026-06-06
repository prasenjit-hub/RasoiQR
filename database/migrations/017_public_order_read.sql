-- Migration 017: Allow public to view orders by ID

CREATE POLICY "Public can view orders" ON orders FOR SELECT USING (TRUE);
