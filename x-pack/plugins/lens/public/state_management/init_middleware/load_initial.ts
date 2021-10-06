/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MiddlewareAPI } from '@reduxjs/toolkit';
import { isEqual } from 'lodash';
import { i18n } from '@kbn/i18n';
import { History } from 'history';
import { LensAppState, setState, initEmpty, LensStoreDeps } from '..';
import { SharingSavedObjectProps } from '../../types';
import { LensEmbeddableInput, LensByReferenceInput } from '../../embeddable/embeddable';
import { getInitialDatasourceId } from '../../utils';
import { initializeDatasources } from '../../editor_frame_service/editor_frame';
import { LensAppServices } from '../../app_plugin/types';
import { getEditPath, getFullPath, LENS_EMBEDDABLE_TYPE } from '../../../common/constants';
import { Document, injectFilterReferences } from '../../persistence';

export const getPersisted = async ({
  initialInput,
  lensServices,
  history,
}: {
  initialInput: LensEmbeddableInput;
  lensServices: LensAppServices;
  history?: History<unknown>;
}): Promise<
  { doc: Document; sharingSavedObjectProps: Omit<SharingSavedObjectProps, 'errorJSON'> } | undefined
> => {
  const { notifications, spaces, attributeService } = lensServices;
  let doc: Document;

  try {
    const result = await attributeService.unwrapAttributes(initialInput);
    if (!result) {
      return {
        doc: {
          ...initialInput,
          type: LENS_EMBEDDABLE_TYPE,
        } as unknown as Document,
        sharingSavedObjectProps: {
          outcome: 'exactMatch',
        },
      };
    }
    const { sharingSavedObjectProps, ...attributes } = result;
    if (spaces && sharingSavedObjectProps?.outcome === 'aliasMatch' && history) {
      // We found this object by a legacy URL alias from its old ID; redirect the user to the page with its new ID, preserving any URL hash
      const newObjectId = sharingSavedObjectProps?.aliasTargetId; // This is always defined if outcome === 'aliasMatch'
      const newPath = lensServices.http.basePath.prepend(
        `${getEditPath(newObjectId)}${history.location.search}`
      );
      await spaces.ui.redirectLegacyUrl(
        newPath,
        i18n.translate('xpack.lens.legacyUrlConflict.objectNoun', {
          defaultMessage: 'Lens visualization',
        })
      );
    }
    doc = {
      ...initialInput,
      ...attributes,
      type: LENS_EMBEDDABLE_TYPE,
    };

    return {
      doc,
      sharingSavedObjectProps: {
        aliasTargetId: sharingSavedObjectProps?.aliasTargetId,
        outcome: sharingSavedObjectProps?.outcome,
      },
    };
  } catch (e) {
    notifications.toasts.addDanger(
      i18n.translate('xpack.lens.app.docLoadingError', {
        defaultMessage: 'Error loading saved document',
      })
    );
  }
};

export function loadInitial(
  store: MiddlewareAPI,
  { lensServices, datasourceMap, embeddableEditorIncomingState, initialContext }: LensStoreDeps,
  {
    redirectCallback,
    initialInput,
    emptyState,
    history,
  }: {
    redirectCallback: (savedObjectId?: string) => void;
    initialInput?: LensEmbeddableInput;
    emptyState?: LensAppState;
    history?: History<unknown>;
  }
) {
  const { attributeService, notifications, data, dashboardFeatureFlag } = lensServices;
  const currentSessionId = data.search.session.getSessionId();

  const { lens } = store.getState();
  if (
    !initialInput ||
    (attributeService.inputIsRefType(initialInput) &&
      initialInput.savedObjectId === lens.persistedDoc?.savedObjectId)
  ) {
    return initializeDatasources(datasourceMap, lens.datasourceStates, undefined, initialContext, {
      isFullEditor: true,
    })
      .then((result) => {
        store.dispatch(
          initEmpty({
            newState: {
              ...emptyState,
              searchSessionId: currentSessionId || data.search.session.start(),
              datasourceStates: Object.entries(result).reduce(
                (state, [datasourceId, datasourceState]) => ({
                  ...state,
                  [datasourceId]: {
                    ...datasourceState,
                    isLoading: false,
                  },
                }),
                {}
              ),
              isLoading: false,
            },
            initialContext,
          })
        );
      })
      .catch((e: { message: string }) => {
        notifications.toasts.addDanger({
          title: e.message,
        });
        redirectCallback();
      });
  }

  getPersisted({ initialInput, lensServices, history })
    .then(
      (persisted) => {
        if (persisted) {
          const { doc, sharingSavedObjectProps } = persisted;
          if (attributeService.inputIsRefType(initialInput)) {
            lensServices.chrome.recentlyAccessed.add(
              getFullPath(initialInput.savedObjectId),
              doc.title,
              initialInput.savedObjectId
            );
          }
          // Don't overwrite any pinned filters
          data.query.filterManager.setAppFilters(
            injectFilterReferences(doc.state.filters, doc.references)
          );

          const docDatasourceStates = Object.entries(doc.state.datasourceStates).reduce(
            (stateMap, [datasourceId, datasourceState]) => ({
              ...stateMap,
              [datasourceId]: {
                isLoading: true,
                state: datasourceState,
              },
            }),
            {}
          );

          initializeDatasources(
            datasourceMap,
            docDatasourceStates,
            doc.references,
            initialContext,
            {
              isFullEditor: true,
            }
          )
            .then((result) => {
              store.dispatch(
                setState({
                  sharingSavedObjectProps,
                  query: doc.state.query,
                  searchSessionId:
                    dashboardFeatureFlag.allowByValueEmbeddables &&
                    Boolean(embeddableEditorIncomingState?.originatingApp) &&
                    !(initialInput as LensByReferenceInput)?.savedObjectId &&
                    currentSessionId
                      ? currentSessionId
                      : data.search.session.start(),
                  ...(!isEqual(lens.persistedDoc, doc) ? { persistedDoc: doc } : null),
                  activeDatasourceId: getInitialDatasourceId(datasourceMap, doc),
                  visualization: {
                    activeId: doc.visualizationType,
                    state: doc.state.visualization,
                  },
                  datasourceStates: Object.entries(result).reduce(
                    (state, [datasourceId, datasourceState]) => ({
                      ...state,
                      [datasourceId]: {
                        ...datasourceState,
                        isLoading: false,
                      },
                    }),
                    {}
                  ),
                  isLoading: false,
                })
              );
            })
            .catch((e: { message: string }) =>
              notifications.toasts.addDanger({
                title: e.message,
              })
            );
        } else {
          redirectCallback();
        }
      },
      () => {
        store.dispatch(
          setState({
            isLoading: false,
          })
        );
        redirectCallback();
      }
    )
    .catch((e: { message: string }) => {
      notifications.toasts.addDanger({
        title: e.message,
      });
      redirectCallback();
    });
}
