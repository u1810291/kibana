/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RouteComponentProps } from 'react-router-dom';
import React, { Component, Fragment, ContextType } from 'react';
import {
  EuiCallOut,
  EuiPage,
  EuiLoadingKibana,
  EuiOverlayMask,
  EuiPageContent,
  EuiPageContentHeader,
  EuiSpacer,
  EuiStepsHorizontal,
  EuiTitle,
} from '@elastic/eui';

import { cloneDeep, mapValues, set, get } from 'lodash';

import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n/react';

import { withKibana } from '../../../../../../../src/plugins/kibana_react/public';

import { AppContext } from '../../app_context';
import { getPolicyEditPath, getPolicyCreatePath } from '../../services/navigation';

import { serializeRollup, deserializeRollup } from './serialize_and_deserialize_rollup';
import { InternalRollup } from './types';

// const createBreadcrumb = {
//   text: i18n.translate('xpack.rollupJobs.createBreadcrumbTitle', {
//     defaultMessage: 'Create',
//   }),
// };

// @ts-ignore
import { Navigation } from './navigation';

import {
  StepLogistics,
  StepDateHistogram,
  StepTerms,
  StepHistogram,
  StepMetrics,
  StepReview,
  // @ts-ignore
} from './steps';

import {
  STEP_LOGISTICS,
  STEP_DATE_HISTOGRAM,
  STEP_TERMS,
  STEP_HISTOGRAM,
  STEP_METRICS,
  STEP_REVIEW,
  stepIds,
  stepIdToStepConfigMap,
  getAffectedStepsFields,
  hasErrors,
  // @ts-ignore
} from './steps_config';

// TODO: fix anys!

const stepIdToTitleMap = {
  [STEP_LOGISTICS]: i18n.translate('xpack.rollupJobs.create.steps.stepLogisticsTitle', {
    defaultMessage: 'Logistics',
  }),
  [STEP_DATE_HISTOGRAM]: i18n.translate('xpack.rollupJobs.create.steps.stepDateHistogramTitle', {
    defaultMessage: 'Date histogram',
  }),
  [STEP_TERMS]: i18n.translate('xpack.rollupJobs.create.steps.stepTermsTitle', {
    defaultMessage: 'Terms',
  }),
  [STEP_HISTOGRAM]: i18n.translate('xpack.rollupJobs.create.steps.stepHistogramTitle', {
    defaultMessage: 'Histogram',
  }),
  [STEP_METRICS]: i18n.translate('xpack.rollupJobs.create.steps.stepMetricsTitle', {
    defaultMessage: 'Metrics',
  }),
  [STEP_REVIEW]: i18n.translate('xpack.rollupJobs.create.steps.stepReviewTitle', {
    defaultMessage: 'Review and save',
  }),
};

type Props = RouteComponentProps<{ phase: string }> & {
  isSaving: boolean;
  saveError: { cause: string[]; message: string };
  kibana: unknown;
};

interface StepFields {
  STEP_LOGISTICS: { rollupIndexIlmPolicy?: string };
  STEP_DATE_HISTOGRAM: {
    dateHistogramInterval: string;
    dateHistogramTimeZone: string;
    dateHistogramField: string;
  };
  STEP_TERMS: { terms: Array<{ name: string }> };
  STEP_HISTOGRAM: { histogram: Array<{ name: string }>; histogramInterval: string };
  STEP_METRICS: { metrics: Array<{ name: string; types: string[] }> };
  STEP_REVIEW: {};
}

interface State {
  checkpointStepId: string;
  currentStepId: keyof StepFields;
  nextStepId: keyof StepFields;
  previousStepId?: keyof StepFields;
  stepsFieldErrors: Record<string, Record<string, string | undefined>>;
  areStepErrorsVisible: boolean;
  stepsFields: StepFields;
}

export class RollupWizardUi extends Component<Props, State> {
  static contextType = AppContext;

  lastIndexPatternValidationTime: number;
  // @ts-ignore
  private _isMounted = false;

  context!: ContextType<typeof AppContext>;

  constructor(props: Props) {
    super(props);

    // props.kibana.services.setBreadcrumbs([listBreadcrumb, createBreadcrumb]);

    const { getCurrentPolicyData } = this.context;
    const {
      match: {
        params: { phase },
      },
    } = props;

    const currentPolicyData = getCurrentPolicyData();
    if (!currentPolicyData) {
      throw new Error('No policy data provided!');
    }
    const rollupAction = get(currentPolicyData.policy, `phases.${phase}.actions.rollup`);
    const internalRollup = deserializeRollup(rollupAction);

    const stepsFields = mapValues(stepIdToStepConfigMap, (step) =>
      cloneDeep(step.getDefaultFields(internalRollup))
    );
    this.state = {
      checkpointStepId: stepIds[0],
      currentStepId: stepIds[0],
      nextStepId: stepIds[1],
      previousStepId: undefined,
      stepsFieldErrors: this.getStepsFieldsErrors(stepsFields),
      areStepErrorsVisible: false,
      stepsFields,
    };

    this.lastIndexPatternValidationTime = 0;
  }

  componentDidMount() {
    window.scroll({ top: 0 });
    this._isMounted = true;
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  getSteps() {
    const { currentStepId, checkpointStepId } = this.state;
    const indexOfCurrentStep = stepIds.indexOf(currentStepId);

    return stepIds.map((stepId: any, index: number) => ({
      title: stepIdToTitleMap[stepId],
      isComplete: index < indexOfCurrentStep,
      isSelected: index === indexOfCurrentStep,
      onClick: () => this.goToStep(stepId),
      disabled:
        !this.canGoToStep(stepId) || stepIds.indexOf(stepId) > stepIds.indexOf(checkpointStepId),
      'data-test-subj':
        index === indexOfCurrentStep
          ? `createRollupStep${index + 1}--active`
          : `createRollupStep${index + 1}`,
    }));
  }

  goToNextStep = () => {
    this.goToStep(this.state.nextStepId);
  };

  goToPreviousStep = () => {
    this.goToStep(this.state.previousStepId);
  };

  goToStep(stepId: any) {
    // Instead of disabling the Next button while the step is invalid, we
    // instead allow the user to click the Next button, prevent them leaving
    // this step, and render a global error message to clearly convey the
    // error.
    if (!this.canGoToStep(stepId)) {
      this.setState({
        areStepErrorsVisible: true,
      });
      return;
    }

    const currentStepIndex = stepIds.indexOf(stepId);

    this.setState({
      currentStepId: stepId,
      nextStepId: stepIds[currentStepIndex + 1],
      previousStepId: stepIds[currentStepIndex - 1],
      areStepErrorsVisible: false,
    });

    if (stepIds.indexOf(stepId) > stepIds.indexOf(this.state.checkpointStepId)) {
      this.setState({ checkpointStepId: stepId });
    }
  }

  canGoToStep(stepId: any) {
    const indexOfStep = stepIds.indexOf(stepId);

    // Check every step before this one and see if it's been completed.
    const prerequisiteSteps = stepIds.slice(0, indexOfStep);

    return prerequisiteSteps.every(
      (prerequisiteStepId: any) => !this.hasStepErrors(prerequisiteStepId)
    );
  }

  hasStepErrors(stepId: any) {
    const { stepsFieldErrors } = this.state;

    const stepFieldErrors = stepsFieldErrors[stepId];
    return Object.values(stepFieldErrors).some((error) => error != null);
  }

  getStepsFieldsErrors(newStepsFields: any) {
    return Object.keys(newStepsFields).reduce((stepsFieldErrors: any, stepId) => {
      const stepFields = newStepsFields[stepId];
      const fieldsValidator = stepIdToStepConfigMap[stepId].fieldsValidator;
      stepsFieldErrors[stepId] =
        typeof fieldsValidator === `function` ? fieldsValidator(stepFields) : {};
      return stepsFieldErrors;
    }, {});
  }

  onFieldsChange = (fields: any, currentStepId = this.state.currentStepId) => {
    const { stepsFields } = this.state;
    const prevFields = stepsFields[currentStepId];

    const affectedStepsFields = getAffectedStepsFields(fields, stepsFields);

    const newFields = {
      ...prevFields,
      ...fields,
    };

    const newStepsFields = {
      ...affectedStepsFields,
      [currentStepId]: newFields,
    };

    this.setState({
      stepsFields: newStepsFields,
      stepsFieldErrors: this.getStepsFieldsErrors(newStepsFields),
    });
  };

  getAllFields(): InternalRollup {
    const {
      stepsFields: {
        STEP_LOGISTICS: { rollupIndexIlmPolicy },
        STEP_DATE_HISTOGRAM: { dateHistogramInterval, dateHistogramTimeZone, dateHistogramField },
        STEP_TERMS: { terms },
        STEP_HISTOGRAM: { histogram, histogramInterval },
        STEP_METRICS: { metrics },
        STEP_REVIEW: {},
      },
    } = this.state;

    return {
      rollupIndexIlmPolicy,
      dateHistogramInterval,
      dateHistogramTimeZone,
      dateHistogramField,
      terms,
      histogram,
      histogramInterval,
      metrics,
    };
  }

  save = () => {
    const rollupConfig = this.getAllFields();
    const { getCurrentPolicyData, setCurrentPolicyData } = this.context;
    const {
      match: {
        params: { phase },
      },
      history,
    } = this.props;
    const currentPolicyData = getCurrentPolicyData();
    if (!currentPolicyData) {
      throw new Error('No policy to update with rollup config!');
    }
    const { isNewPolicy, policy } = cloneDeep(currentPolicyData);
    set(policy, `phases.${phase}.actions.rollup.config`, serializeRollup(rollupConfig));
    set(policy, `phases.${phase}.actions.rollup.rollup_policy`, rollupConfig.rollupIndexIlmPolicy);
    setCurrentPolicyData({ policy, isNewPolicy });
    if (isNewPolicy) {
      history.push(getPolicyCreatePath());
    } else {
      history.push(getPolicyEditPath(policy.name));
    }
  };

  render() {
    const { isSaving, saveError } = this.props;

    let savingFeedback;

    if (isSaving) {
      savingFeedback = (
        <EuiOverlayMask>
          <EuiLoadingKibana size="xl" />
        </EuiOverlayMask>
      );
    }

    let saveErrorFeedback;

    if (saveError) {
      const { message, cause } = saveError;

      let errorBody;

      if (cause) {
        if (cause.length === 1) {
          errorBody = <p>{cause[0]}</p>;
        } else {
          errorBody = (
            <ul>
              {cause.map((causeValue: any) => (
                <li key={causeValue}>{causeValue}</li>
              ))}
            </ul>
          );
        }
      }

      saveErrorFeedback = (
        <Fragment>
          <EuiCallOut title={message} iconType="cross" color="danger">
            {errorBody}
          </EuiCallOut>

          <EuiSpacer />
        </Fragment>
      );
    }

    return (
      <EuiPage>
        <EuiPageContent>
          <EuiPageContentHeader>
            <EuiTitle size="l">
              <h1>
                <FormattedMessage
                  id="xpack.rollupJobs.createTitle"
                  defaultMessage="Configure rollup action"
                />
              </h1>
            </EuiTitle>
          </EuiPageContentHeader>

          {saveErrorFeedback}

          <EuiStepsHorizontal steps={this.getSteps()} />

          <EuiSpacer />

          {this.renderCurrentStep()}

          <EuiSpacer size="l" />

          {this.renderNavigation()}
        </EuiPageContent>
        {savingFeedback}
      </EuiPage>
    );
  }

  renderCurrentStep() {
    const { currentStepId, stepsFields, stepsFieldErrors, areStepErrorsVisible } = this.state;

    const currentStepFields = stepsFields[currentStepId];
    const currentStepFieldErrors = stepsFieldErrors[currentStepId];

    switch (currentStepId) {
      case STEP_LOGISTICS:
        return (
          <StepLogistics
            fields={currentStepFields}
            onFieldsChange={this.onFieldsChange}
            fieldErrors={currentStepFieldErrors}
            hasErrors={hasErrors(currentStepFieldErrors)}
            areStepErrorsVisible={areStepErrorsVisible}
          />
        );

      case STEP_DATE_HISTOGRAM:
        return (
          <StepDateHistogram
            fields={currentStepFields}
            onFieldsChange={this.onFieldsChange}
            fieldErrors={currentStepFieldErrors}
            hasErrors={hasErrors(currentStepFieldErrors)}
            areStepErrorsVisible={areStepErrorsVisible}
          />
        );

      case STEP_TERMS:
        return <StepTerms fields={currentStepFields} onFieldsChange={this.onFieldsChange} />;

      case STEP_HISTOGRAM:
        return (
          <StepHistogram
            fields={currentStepFields}
            onFieldsChange={this.onFieldsChange}
            fieldErrors={currentStepFieldErrors}
            hasErrors={hasErrors(currentStepFieldErrors)}
            areStepErrorsVisible={areStepErrorsVisible}
          />
        );

      case STEP_METRICS:
        return (
          <StepMetrics
            fields={currentStepFields}
            onFieldsChange={this.onFieldsChange}
            fieldErrors={currentStepFieldErrors}
            areStepErrorsVisible={areStepErrorsVisible}
          />
        );

      case STEP_REVIEW:
        return <StepReview job={this.getAllFields()} />;

      default:
        return null;
    }
  }

  renderNavigation() {
    const { nextStepId, previousStepId, areStepErrorsVisible } = this.state;

    const { isSaving } = this.props;
    const hasNextStep = nextStepId != null;

    // Users can click the next step button as long as validation hasn't executed, and as long
    // as we're not waiting on async validation to complete.
    const canGoToNextStep = hasNextStep && (!areStepErrorsVisible || this.canGoToStep(nextStepId));

    return (
      <Navigation
        isSaving={isSaving}
        hasNextStep={hasNextStep}
        hasPreviousStep={previousStepId != null}
        goToNextStep={this.goToNextStep}
        goToPreviousStep={this.goToPreviousStep}
        canGoToNextStep={canGoToNextStep}
        save={this.save}
      />
    );
  }
}

export const RollupWizard = withKibana(RollupWizardUi as any);
