// DMIS Auto Fill - Content Script
// Injected into NHSO DMIS pages to auto-fill dialysis patient data

(function() {
  'use strict';

  // Prevent double-injection
  if (window.__dmisAutoFillInjected) return;
  window.__dmisAutoFillInjected = true;

  let currentData = null;
  let isFilling = false;

  // Field mapping: JSON field name -> possible form field identifiers
  const FIELD_MAP = {
    hn: ['hn', 'HN', 'patient_id', 'pid', 'รหัสผู้ป่วย'],
    ptname: ['ptname', 'name', 'patient_name', 'ชื่อผู้ป่วย', 'full_name'],
    onset: ['onset', 'onset_date', 'start_date', 'วันที่เริ่ม', 'date_onset'],
    pre_weight: ['pre_weight', 'preweight', 'weight_before', 'น้ำหนักก่อน', 'bw_pre'],
    post_weight: ['post_weight', 'postweight', 'weight_after', 'น้ำหนักหลัง', 'bw_post'],
    pttype: ['pttype', 'pt_type', 'type', 'สิทธิ', 'right'],
    hipdata: ['hipdata', 'hip', 'kt_v', 'ktv', 'urea_reduction', 'urr'],
    hd_claim: ['hd_claim', 'claim', 'claim_code', 'รหัสเคลม'],
    creatinine: ['creatinine', 'cre', 'crt'],
    dry_weight: ['dry_weight', 'dryweight', 'idwg', 'น้ำหนักแห้ง'],
    off_time: ['off_time', 'offtime', 'duration', 'เวลาลง', 'time_off'],
    blood_flow: ['blood_flow', 'bf', 'qb', 'bloodflow'],
    dialysate_flow: ['dialysate_flow', 'df', 'qd', 'dialysateflow'],
    uf_goal: ['uf_goal', 'ufgoal', 'uf', 'ultrafiltration'],
    uf_actual: ['uf_actual', 'ufactual', 'uf_real'],
    bp_pre_systolic: ['bp_pre_sys', 'bp_pre_systolic', 'sbp_pre'],
    bp_pre_diastolic: ['bp_pre_dia', 'bp_pre_diastolic', 'dbp_pre'],
    bp_post_systolic: ['bp_post_sys', 'bp_post_systolic', 'sbp_post'],
    bp_post_diastolic: ['bp_post_dia', 'bp_post_diastolic', 'dbp_post'],
    heparin_dose: ['heparin', 'heparin_dose', 'anticoagulant'],
    access_type: ['access', 'access_type', 'vascular_access', 'access_site'],
    dialyzer: ['dialyzer', 'dialyser', 'filter'],
    membrane: ['membrane', 'membrane_type']
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startFilling') {
      if (isFilling) {
        sendResponse({ success: false, error: 'Already filling data' });
        return true;
      }
      startFillingProcess(request.data);
      sendResponse({ success: true, message: 'Filling process started' });
      return true;
    }
    if (request.action === 'getStatus') {
      sendResponse({ success: true, isFilling, currentData });
      return true;
    }
    if (request.action === 'fillNext') {
      fillNextPatient();
      sendResponse({ success: true });
      return true;
    }
    return false;
  });

  async function startFillingProcess(data) {
    isFilling = true;
    currentData = data;
    showNotification('Starting auto-fill for ' + data.length + ' patient(s)', 'info');

    for (let i = 0; i < data.length; i++) {
      const patient = data[i];
      const patientData = patient.data || patient;
      const name = patientData.ptname || patientData.hn || '';
      showNotification('Filling patient ' + (i + 1) + '/' + data.length + ': ' + name, 'info');

      try {
        await fillPatientForm(patientData);
        await reportStatus('markCompleted');
        if (i < data.length - 1) {
          showNotification('Patient ' + (i + 1) + ' filled. Please save and click Next when ready.', 'success');
          await waitForUserOrAutoProceed();
        } else {
          showNotification('All patients filled successfully!', 'success');
        }
      } catch (err) {
        console.error('Error filling patient:', err);
        showNotification('Error filling patient ' + (i + 1) + ': ' + err.message, 'error');
        await reportStatus('markError', { message: err.message, patient: patientData.hn || patientData.ptname || 'index ' + i });
      }
    }

    isFilling = false;
    currentData = null;
  }

  async function fillPatientForm(patient) {
    const filled = [];
    const notFound = [];

    for (const [jsonField, possibleNames] of Object.entries(FIELD_MAP)) {
      const value = patient[jsonField];
      if (value === undefined || value === null || value === '') continue;
      const element = findFormField(possibleNames);
      if (element) {
        await setFieldValue(element, value);
        filled.push(jsonField);
      } else {
        notFound.push(jsonField);
      }
    }

    for (const [key, value] of Object.entries(patient)) {
      if (value === undefined || value === null || value === '') continue;
      if (filled.includes(key)) continue;
      const element = findFormField([key]);
      if (element) {
        await setFieldValue(element, value);
        filled.push(key);
      }
    }

    console.log('DMIS Auto Fill: Filled fields:', filled);
    if (notFound.length > 0) console.log('DMIS Auto Fill: Fields not found:', notFound);
    return { filled, notFound };
  }

  function findFormField(possibleNames) {
    for (const name of possibleNames) {
      let el = document.getElementById(name);
      if (el && isInputLike(el)) return el;

      el = document.querySelector('[name="' + name + '"]');
      if (el && isInputLike(el)) return el;

      const allIds = document.querySelectorAll('[id]');
      for (const node of allIds) {
        if (node.id.toLowerCase() === name.toLowerCase() && isInputLike(node)) return node;
      }

      const allNames = document.querySelectorAll('[name]');
      for (const node of allNames) {
        if (node.name.toLowerCase() === name.toLowerCase() && isInputLike(node)) return node;
      }

      const byPlaceholder = document.querySelector('[placeholder*="' + name + '" i]');
      if (byPlaceholder && isInputLike(byPlaceholder)) return byPlaceholder;

      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (label.textContent.toLowerCase().includes(name.toLowerCase())) {
          const forAttr = label.getAttribute('for');
          if (forAttr) {
            el = document.getElementById(forAttr);
            if (el && isInputLike(el)) return el;
          }
          el = label.querySelector('input, select, textarea');
          if (el) return el;
        }
      }
    }
    return null;
  }

  function isInputLike(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
  }

  async function setFieldValue(element, value) {
    const tagName = element.tagName;
    const type = element.type;

    if (tagName === 'SELECT') {
      const strValue = String(value).toLowerCase();
      let matched = false;
      for (const option of element.options) {
        if (option.value.toLowerCase() === strValue || option.text.toLowerCase().includes(strValue)) {
          element.value = option.value;
          matched = true;
          break;
        }
      }
      if (!matched) element.value = value;
    } else if (type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (type === 'radio') {
      const radios = document.querySelectorAll('[name="' + element.name + '"]');
      for (const radio of radios) {
        if (radio.value === String(value)) {
          radio.checked = true;
          break;
        }
      }
    } else if (type === 'date' && value) {
      element.value = formatDateValue(value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(50);
  }

  function formatDateValue(value) {
    if (!value) return '';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      if (date.getFullYear() < 1901) return '';
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    } catch {
      return String(value);
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForUserOrAutoProceed() {
    await sleep(3000);
  }

  async function reportStatus(action, data) {
    try {
      await chrome.runtime.sendMessage({ action, ...data });
    } catch (e) {
      console.error('Failed to report status:', e);
    }
  }

  function fillNextPatient() {
    chrome.runtime.sendMessage({ action: 'getNextPatient' }, (response) => {
      if (response && response.success) {
        fillPatientForm(response.patient);
      }
    });
  }

  function showNotification(message, type) {
    const existing = document.getElementById('__dmisAutoFillNotification');
    if (existing) existing.remove();

    const colors = {
      info: { bg: '#1d72ef' },
      success: { bg: '#10b981' },
      error: { bg: '#ef4444' },
      warning: { bg: '#f59e0b' }
    };
    const c = colors[type] || colors.info;

    const div = document.createElement('div');
    div.id = '__dmisAutoFillNotification';
    div.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:' + c.bg + ';color:white;padding:12px 20px;border-radius:12px;font-family:Sarabun,sans-serif;font-size:14px;box-shadow:0 10px 30px -5px rgba(0,0,0,0.3);max-width:400px;display:flex;align-items:center;gap:8px;';
    div.textContent = message;
    document.body.appendChild(div);

    if (type !== 'error') {
      setTimeout(() => {
        div.style.opacity = '0';
        div.style.transform = 'translateX(100%)';
        div.style.transition = 'all 0.3s ease';
        setTimeout(() => div.remove(), 300);
      }, 5000);
    }
  }

  console.log('DMIS Auto Fill: Content script loaded and ready');
})();
