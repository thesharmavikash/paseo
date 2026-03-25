import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowLeft, Check, ChevronDown, ChevronRight } from "lucide-react-native";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import { Combobox, ComboboxItem, SearchInput } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";

const INLINE_MODEL_THRESHOLD = 8;

type DrillDownView = { provider: string };

function resolveDefaultModelLabel(models: AgentModelDefinition[] | undefined): string {
  if (!models || models.length === 0) {
    return "Select model";
  }
  return (models.find((model) => model.isDefault) ?? models[0])?.label ?? "Select model";
}

interface CombinedModelSelectorProps {
  providerDefinitions: AgentProviderDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  disabled?: boolean;
}

export function CombinedModelSelector({
  providerDefinitions,
  allProviderModels,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  disabled = false,
}: CombinedModelSelectorProps) {
  const { theme } = useUnistyles();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"groups" | DrillDownView>("groups");
  const [searchQuery, setSearchQuery] = useState("");

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        const models = allProviderModels.get(selectedProvider);
        if (models && models.length > INLINE_MODEL_THRESHOLD) {
          setView({ provider: selectedProvider });
        }
      } else {
        setView("groups");
        setSearchQuery("");
      }
    },
    [allProviderModels, selectedProvider],
  );

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider as AgentProvider, modelId);
      setIsOpen(false);
      setView("groups");
      setSearchQuery("");
    },
    [onSelect],
  );

  const ProviderIcon = getProviderIcon(selectedProvider);

  const selectedModelLabel = useMemo(() => {
    const models = allProviderModels.get(selectedProvider);
    if (!models) return isLoading ? "Loading..." : "Select model";
    const model = models.find((m) => m.id === selectedModel);
    return model?.label ?? resolveDefaultModelLabel(models);
  }, [allProviderModels, selectedProvider, selectedModel, isLoading]);

  return (
    <>
      <Pressable
        ref={anchorRef}
        collapsable={false}
        disabled={disabled}
        onPress={() => handleOpenChange(!isOpen)}
        style={({ pressed, hovered }) => [
          styles.trigger,
          hovered && styles.triggerHovered,
          (pressed || isOpen) && styles.triggerPressed,
          disabled && styles.triggerDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Select model (${selectedModelLabel})`}
        testID="combined-model-selector"
      >
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        <Text style={styles.triggerText}>{selectedModelLabel}</Text>
        <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>
      <Combobox
        options={[]}
        value=""
        onSelect={() => {}}
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        title="Select model"
      >
        {view === "groups" ? (
          <GroupsView
            providerDefinitions={providerDefinitions}
            allProviderModels={allProviderModels}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onSelect={handleSelect}
            onDrillDown={(provider) => {
              setView({ provider });
              setSearchQuery("");
            }}
          />
        ) : (
          <DrillDownModelView
            provider={view.provider}
            providerDefinitions={providerDefinitions}
            models={allProviderModels.get(view.provider) ?? []}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelect={handleSelect}
            onBack={() => {
              setView("groups");
              setSearchQuery("");
            }}
          />
        )}
      </Combobox>
    </>
  );
}

function GroupsView({
  providerDefinitions,
  allProviderModels,
  selectedProvider,
  selectedModel,
  onSelect,
  onDrillDown,
}: {
  providerDefinitions: AgentProviderDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, modelId: string) => void;
  onDrillDown: (provider: string) => void;
}) {
  const { theme } = useUnistyles();

  return (
    <View>
      {providerDefinitions.map((def, index) => {
        const models = allProviderModels.get(def.id) ?? [];
        const isInline = models.length <= INLINE_MODEL_THRESHOLD;
        const ProvIcon = getProviderIcon(def.id);

        return (
          <View key={def.id}>
            {index > 0 ? <View style={styles.separator} /> : null}

            {isInline ? (
              <>
                <View style={styles.sectionHeading}>
                  <ProvIcon size={14} color={theme.colors.foregroundMuted} />
                  <Text style={styles.sectionHeadingText}>{def.label}</Text>
                </View>
                {models.map((model) => (
                  <ComboboxItem
                    key={model.id}
                    label={model.label}
                    selected={model.id === selectedModel && def.id === selectedProvider}
                    onPress={() => onSelect(def.id, model.id)}
                  />
                ))}
              </>
            ) : (
              <Pressable
                onPress={() => onDrillDown(def.id)}
                style={({ pressed, hovered }) => [
                  styles.drillDownRow,
                  hovered && styles.drillDownRowHovered,
                  pressed && styles.drillDownRowPressed,
                ]}
              >
                <ProvIcon size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.drillDownText}>{def.label}</Text>
                <View style={styles.drillDownTrailing}>
                  <Text style={styles.drillDownCount}>{models.length}</Text>
                  <ChevronRight size={14} color={theme.colors.foregroundMuted} />
                </View>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

function DrillDownModelView({
  provider,
  providerDefinitions,
  models,
  selectedProvider,
  selectedModel,
  searchQuery,
  onSearchChange,
  onSelect,
  onBack,
}: {
  provider: string;
  providerDefinitions: AgentProviderDefinition[];
  models: AgentModelDefinition[];
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelect: (provider: string, modelId: string) => void;
  onBack: () => void;
}) {
  const { theme } = useUnistyles();
  const ProvIcon = getProviderIcon(provider);
  const providerLabel = providerDefinitions.find((d) => d.id === provider)?.label ?? provider;

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models;
    const q = searchQuery.toLowerCase();
    return models.filter(
      (m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [models, searchQuery]);

  return (
    <View>
      <Pressable
        onPress={onBack}
        style={({ pressed, hovered }) => [
          styles.backButton,
          hovered && styles.backButtonHovered,
          pressed && styles.backButtonPressed,
        ]}
      >
        <ArrowLeft size={14} color={theme.colors.foregroundMuted} />
        <ProvIcon size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.backButtonText}>{providerLabel}</Text>
      </Pressable>

      <SearchInput
        placeholder="Search models..."
        value={searchQuery}
        onChangeText={onSearchChange}
        autoFocus={Platform.OS === "web"}
      />

      {filteredModels.map((model) => (
        <ComboboxItem
          key={model.id}
          label={model.label}
          description={model.description}
          selected={model.id === selectedModel && provider === selectedProvider}
          onPress={() => onSelect(provider, model.id)}
        />
      ))}

      {filteredModels.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>No models match your search</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  sectionHeadingText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  drillDownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  drillDownRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  drillDownRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  drillDownText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  drillDownTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  drillDownCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  backButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  backButtonText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  emptyState: {
    paddingVertical: theme.spacing[4],
    alignItems: "center",
  },
  emptyStateText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
