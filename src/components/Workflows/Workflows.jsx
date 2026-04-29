import { useState } from 'react';
import Header from '../Layout/Header';
import Badge from '../common/Badge';
import { workflows } from '../../data/mockData';
import './Workflows.css';

const stepTypeColor = {
  task: '#64748b',
  review: '#f59e0b',
  negotiation: '#8b5cf6',
  approval: '#4f8ef7',
  signature: '#10b981',
  system: '#94a3b8',
};

const stepTypeIcon = {
  task: '📝',
  review: '🔍',
  negotiation: '🤝',
  approval: '✅',
  signature: '✍️',
  system: '⚙️',
};

export default function Workflows() {
  const [selected, setSelected] = useState(workflows[0]);
  const [activeInstances] = useState([
    { id: 'WFI-001', contract: 'CLM-2024-008', workflow: 'WF-001', currentStep: 2, startedDate: '2024-04-15', assignedTo: 'James Porter' },
    { id: 'WFI-002', contract: 'CLM-2024-003', workflow: 'WF-002', currentStep: 1, startedDate: '2024-04-18', assignedTo: 'James Porter' },
    { id: 'WFI-003', contract: 'CLM-2024-006', workflow: 'WF-001', currentStep: 6, startedDate: '2024-04-01', assignedTo: 'David Park' },
  ]);

  const getWorkflowForInstance = (wfId) => workflows.find((w) => w.id === wfId);

  return (
    <div className="workflows">
      <Header
        title="Workflows"
        subtitle="Manage approval workflows and track active processes"
      />

      <div className="workflows__content">
        {/* Active Instances */}
        <div className="workflows__card">
          <div className="workflows__card-header">
            <h3 className="workflows__section-title">Active Workflow Instances</h3>
            <span className="workflows__count">{activeInstances.length} running</span>
          </div>

          <div className="workflows__instances">
            {activeInstances.map((inst) => {
              const wf = getWorkflowForInstance(inst.workflow);
              const currentStepData = wf?.steps[inst.currentStep - 1];
              const progress = Math.round((inst.currentStep / (wf?.steps.length || 1)) * 100);
              return (
                <div key={inst.id} className="workflows__instance">
                  <div className="workflows__instance-header">
                    <div className="workflows__instance-info">
                      <span className="workflows__instance-contract">{inst.contract}</span>
                      <span className="workflows__instance-wf">{wf?.name}</span>
                    </div>
                    <span className="workflows__instance-assignee">
                      <span className="workflows__instance-avatar">{inst.assignedTo.split(' ').map(w => w[0]).join('')}</span>
                      {inst.assignedTo}
                    </span>
                  </div>

                  <div className="workflows__instance-progress">
                    <div className="workflows__progress-track">
                      <div
                        className="workflows__progress-fill"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="workflows__progress-label">
                      Step {inst.currentStep} / {wf?.steps.length}
                    </span>
                  </div>

                  <div className="workflows__instance-current">
                    <span
                      className="workflows__step-badge"
                      style={{ background: `${stepTypeColor[currentStepData?.type]}20`, color: stepTypeColor[currentStepData?.type] }}
                    >
                      {stepTypeIcon[currentStepData?.type]} {currentStepData?.name}
                    </span>
                    <span className="workflows__instance-date">Started {inst.startedDate}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Workflow Library */}
        <div className="workflows__library">
          {/* Left: list */}
          <div className="workflows__list">
            <h3 className="workflows__section-title">Workflow Templates</h3>
            {workflows.map((wf) => (
              <div
                key={wf.id}
                className={`workflows__list-item${selected?.id === wf.id ? ' workflows__list-item--active' : ''}`}
                onClick={() => setSelected(wf)}
              >
                <div className="workflows__list-item-header">
                  <span className="workflows__list-item-name">{wf.name}</span>
                  <Badge status="Active" size="sm" />
                </div>
                <div className="workflows__list-item-meta">
                  <span>{wf.steps.length} steps</span>
                  <span>·</span>
                  <span>~{wf.avgDuration}</span>
                  <span>·</span>
                  <span>Used {wf.usageCount}×</span>
                </div>
                <div className="workflows__list-item-applies">
                  {wf.appliesTo.map((t) => (
                    <span key={t} className="workflows__applies-tag">{t}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Right: detail */}
          {selected && (
            <div className="workflows__detail">
              <div className="workflows__detail-header">
                <div>
                  <h3 className="workflows__detail-title">{selected.name}</h3>
                  <p className="workflows__detail-meta">
                    {selected.steps.length} steps · Avg {selected.avgDuration} · Used {selected.usageCount}×
                  </p>
                </div>
                <div className="workflows__detail-actions">
                  <button className="workflows__action-btn workflows__action-btn--secondary">Edit</button>
                  <button className="workflows__action-btn workflows__action-btn--primary">Start Instance</button>
                </div>
              </div>

              <div className="workflows__applies">
                <span className="workflows__applies-label">Applies to:</span>
                {selected.appliesTo.map((t) => (
                  <span key={t} className="workflows__applies-tag">{t}</span>
                ))}
              </div>

              {/* Steps */}
              <div className="workflows__steps">
                {selected.steps.map((step, i) => (
                  <div key={step.id} className="workflows__step">
                    <div className="workflows__step-left">
                      <div
                        className="workflows__step-circle"
                        style={{ background: stepTypeColor[step.type], color: '#fff' }}
                      >
                        {i + 1}
                      </div>
                      {i < selected.steps.length - 1 && (
                        <div className="workflows__step-connector" />
                      )}
                    </div>
                    <div className="workflows__step-body">
                      <div className="workflows__step-header">
                        <span className="workflows__step-name">{step.name}</span>
                        <span
                          className="workflows__step-type"
                          style={{ background: `${stepTypeColor[step.type]}15`, color: stepTypeColor[step.type] }}
                        >
                          {stepTypeIcon[step.type]} {step.type}
                        </span>
                      </div>
                      <div className="workflows__step-details">
                        <span>👤 {step.role}</span>
                        <span>⏱ SLA: {step.sla}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
