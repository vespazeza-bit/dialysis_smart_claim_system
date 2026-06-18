-- เพิ่มคอลัมน์ claim_status ในตาราง clinic_hd_claim
-- รันครั้งเดียวใน database nampad

ALTER TABLE `clinic_hd_claim`
  ADD COLUMN IF NOT EXISTS `claim_status` VARCHAR(20) DEFAULT NULL AFTER `clinic_hd_claim_sent_by`;
