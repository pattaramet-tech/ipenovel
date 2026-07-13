import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Plus, Edit2, Trash2, Loader2, ArrowLeft, Search } from "lucide-react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

interface AdminEpisodesPageProps {
  params?: {
    novelId?: string;
  };
}

type SortOption = "newest" | "oldest" | "title_asc" | "title_desc";

const SORT_OPTION_MAP: Record<SortOption, { sortBy: "createdAt" | "title"; sortOrder: "asc" | "desc" }> = {
  newest: { sortBy: "createdAt", sortOrder: "desc" },
  oldest: { sortBy: "createdAt", sortOrder: "asc" },
  title_asc: { sortBy: "title", sortOrder: "asc" },
  title_desc: { sortBy: "title", sortOrder: "desc" },
};

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;

export default function AdminEpisodesPage({ params }: AdminEpisodesPageProps) {
  const [, navigate] = useLocation();
  const scopedNovelId = params?.novelId ? parseInt(params.novelId) : undefined;
  const isScoped = !!scopedNovelId;

  const [novelFilter, setNovelFilter] = useState<number | undefined>(scopedNovelId);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [page, setPage] = useState(1);
  const [openDialog, setOpenDialog] = useState(false);
  const [editingEpisodeId, setEditingEpisodeId] = useState<number | null>(null);
  const [editingEpisode, setEditingEpisode] = useState<any>(null);
  const [formData, setFormData] = useState({
    novelId: scopedNovelId || 0,
    episodeNumber: "",
    title: "",
    description: "",
    price: "0",
    isFree: false,
    fileUrl: "",
    content: "",
    contentFormat: "plain_text" as "plain_text" | "markdown" | "html",
    // "chapter" = single episode, sold via direct wallet purchase ("ซื้อทันที").
    // "package" = multi-chapter bundle, sold via cart/checkout, web-read only.
    saleMode: "chapter" as "chapter" | "package",
    isPublished: true,
    publishedAt: new Date(),
    sortOrder: 0,
  });

  // Debounce search ~400ms and reset to page 1 whenever search/filter/sort change.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearchTerm, novelFilter, sortOption]);

  const utils = trpc.useUtils();

  const queryInput = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      novelId: novelFilter,
      search: debouncedSearchTerm.trim() || undefined,
      ...SORT_OPTION_MAP[sortOption],
    }),
    [page, novelFilter, debouncedSearchTerm, sortOption]
  );

  // Lightweight, paginated, backend-filtered list - never ships full episode
  // content to the browser. See server/db.ts getAdminEpisodesList.
  const { data: listData, isLoading } = trpc.admin.episodes.list.useQuery(queryInput);
  const episodesList = listData?.episodes ?? [];
  const total = listData?.total ?? 0;
  const totalPages = listData?.totalPages ?? 1;

  // Novel picker - capped list from the admin-scoped, paginated novel search
  // (never the full unlimited table) for both the filter dropdown and the
  // create/edit dialog's novel select.
  const { data: novelOptions } = trpc.admin.novels.list.useQuery({ limit: 50 });

  // Full episode row (content/fileUrl) is only fetched once an admin opens
  // the Edit dialog for a specific episode - not part of the list payload.
  const { data: episodeDetail, isLoading: detailLoading } = trpc.admin.episodes.detail.useQuery(
    { episodeId: editingEpisodeId! },
    { enabled: !!editingEpisodeId }
  );

  useEffect(() => {
    if (!episodeDetail) return;
    setEditingEpisode(episodeDetail);
    setFormData({
      novelId: episodeDetail.novelId,
      episodeNumber: String(episodeDetail.episodeNumber) || "",
      title: episodeDetail.title || "",
      description: episodeDetail.description || "",
      price: episodeDetail.price || "0",
      isFree: episodeDetail.isFree || false,
      fileUrl: episodeDetail.fileUrl || "",
      content: episodeDetail.content || "",
      contentFormat: (episodeDetail.contentFormat as "plain_text" | "markdown" | "html") || "plain_text",
      saleMode: episodeDetail.saleMode === "package" ? "package" : "chapter",
      isPublished: episodeDetail.isPublished !== false,
      publishedAt: episodeDetail.publishedAt ? new Date(episodeDetail.publishedAt) : new Date(),
      sortOrder: episodeDetail.sortOrder || 0,
    });
  }, [episodeDetail]);

  const createMutation = trpc.admin.episodes.create.useMutation({
    onSuccess: () => {
      toast.success("Episode created successfully!");
      setOpenDialog(false);
      resetForm();
      utils.admin.episodes.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create episode");
    },
  });

  const updateMutation = trpc.admin.episodes.update.useMutation({
    onSuccess: () => {
      toast.success("Episode updated successfully!");
      setOpenDialog(false);
      setEditingEpisode(null);
      setEditingEpisodeId(null);
      utils.admin.episodes.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update episode");
    },
  });

  const deleteMutation = trpc.admin.episodes.delete.useMutation({
    onSuccess: () => {
      toast.success("Episode deleted successfully!");
      utils.admin.episodes.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete episode");
    },
  });

  const resetForm = () => {
    setFormData({
      novelId: scopedNovelId || 0,
      episodeNumber: "",
      title: "",
      description: "",
      price: "0",
      isFree: false,
      fileUrl: "",
      content: "",
      contentFormat: "plain_text",
      saleMode: "chapter",
      isPublished: true,
      publishedAt: new Date(),
      sortOrder: 0,
    });
  };

  const handleSubmit = () => {
    if (!formData.title || !formData.novelId) {
      toast.error("Title and novel are required");
      return;
    }

    if (!formData.isFree && (!formData.price || parseFloat(formData.price) <= 0)) {
      toast.error("Paid episodes must have a price greater than 0");
      return;
    }

    if (editingEpisode) {
      updateMutation.mutate({
        episodeId: editingEpisode.id,
        episodeNumber: formData.episodeNumber || undefined,
        title: formData.title || undefined,
        description: formData.description || undefined,
        price: formData.price || undefined,
        isFree: formData.isFree,
        fileUrl: formData.fileUrl || undefined,
        content: formData.content || undefined,
        contentFormat: formData.contentFormat || undefined,
        saleMode: formData.saleMode,
        isPublished: formData.isPublished,
        publishedAt: formData.publishedAt || undefined,
        sortOrder: formData.sortOrder || undefined,
      });
    } else {
      createMutation.mutate(formData as any);
    }
  };

  const handleEdit = (episode: any) => {
    setEditingEpisode(null);
    setEditingEpisodeId(episode.id);
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setEditingEpisode(null);
    setEditingEpisodeId(null);
    resetForm();
  };

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header with Back Button if Scoped */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {isScoped && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(`/admin/novels/${scopedNovelId}`)}
                className="gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </Button>
            )}
            <h1 className="text-3xl font-bold text-slate-900">
              {isScoped ? "Episodes" : "All Episodes"}
            </h1>
          </div>
        </div>

        {/* Filters and Create Button */}
        <div className="flex flex-col gap-4">
          <div className="flex gap-4 items-center flex-wrap">
            {!isScoped && (
              <select
                value={novelFilter || ""}
                onChange={(e) => setNovelFilter(e.target.value ? parseInt(e.target.value) : undefined)}
                className="px-3 py-2 border rounded-md"
              >
                <option value="">All Novels</option>
                {novelOptions?.map((novel: any) => (
                  <option key={novel.id} value={novel.id}>
                    {novel.title}
                  </option>
                ))}
              </select>
            )}
            <Dialog open={openDialog} onOpenChange={(open) => (open ? setOpenDialog(true) : handleCloseDialog())}>
              <DialogTrigger asChild>
                <Button
                  onClick={() => {
                    setEditingEpisode(null);
                    setEditingEpisodeId(null);
                    resetForm();
                  }}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create Episode
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{editingEpisodeId ? "Edit Episode" : "Create New Episode"}</DialogTitle>
                </DialogHeader>
                {editingEpisodeId && detailLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                  </div>
                ) : (
                <div className="space-y-6 py-4">
                  {/* Basic Info Section */}
                  <div>
                    <h3 className="font-semibold text-sm mb-3">Basic Info</h3>
                    <div className="space-y-3">
                      {!isScoped && (
                        <div>
                          <Label>Novel</Label>
                          <select
                            value={formData.novelId}
                            onChange={(e) => setFormData({ ...formData, novelId: parseInt(e.target.value) })}
                            className="w-full px-3 py-2 border rounded-md"
                          >
                            <option value={0}>Select a novel</option>
                            {novelOptions?.map((novel: any) => (
                              <option key={novel.id} value={novel.id}>
                                {novel.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div>
                        <Label>Episode Number</Label>
                        <Input
                          type="text"
                          value={formData.episodeNumber}
                          onChange={(e) => setFormData({ ...formData, episodeNumber: e.target.value })}
                          placeholder="e.g., 001 - 030 or 1"
                        />
                      </div>
                      <div>
                        <Label>Title</Label>
                        <Input
                          value={formData.title}
                          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                          placeholder="Episode title"
                        />
                      </div>
                      <div>
                        <Label>Description</Label>
                        <Input
                          value={formData.description}
                          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                          placeholder="Brief episode description"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Pricing & Access Section */}
                  <div>
                    <h3 className="font-semibold text-sm mb-3">Pricing & Access</h3>
                    <div className="space-y-3">
                      <div>
                        <Label>ประเภทการขาย (Sale Mode)</Label>
                        <select
                          value={formData.saleMode}
                          onChange={(e) => setFormData({ ...formData, saleMode: e.target.value as "chapter" | "package" })}
                          className="w-full px-3 py-2 border rounded-md"
                        >
                          <option value="chapter">รายบท (single chapter - direct wallet purchase)</option>
                          <option value="package">แพ็กอ่านบนเว็บ (multi-chapter package - cart/checkout, web-read only)</option>
                        </select>
                        <p className="text-xs text-muted-foreground mt-1">
                          {formData.saleMode === "package"
                            ? "ใช้ content เป็นเนื้อหาหลายบทรวมกัน ขายผ่านตะกร้า ไม่มีดาวน์โหลด"
                            : "ใช้ content เป็นเนื้อหาตอนเดียว ขายผ่านปุ่มซื้อทันที"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData.isFree}
                          onChange={(e) => setFormData({ ...formData, isFree: e.target.checked })}
                          id="isFree"
                        />
                        <Label htmlFor="isFree" className="cursor-pointer">Free Episode</Label>
                      </div>
                      {!formData.isFree && (
                        <div>
                          <Label>Price (฿)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={formData.price}
                            onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                            placeholder="0.00"
                          />
                        </div>
                      )}
                      {formData.saleMode === "package" && (
                        <div>
                          <Label>File URL (Legacy, optional - not used by the web reader)</Label>
                          <Input
                            value={formData.fileUrl}
                            onChange={(e) => setFormData({ ...formData, fileUrl: e.target.value })}
                            placeholder="https://... (leave empty for new packages)"
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Content Section */}
                  <div>
                    <h3 className="font-semibold text-sm mb-3">Web Reader Content</h3>
                    <div className="space-y-3">
                      <div>
                        <Label>Content Format</Label>
                        <select
                          value={formData.contentFormat}
                          onChange={(e) => setFormData({ ...formData, contentFormat: e.target.value as any })}
                          className="w-full px-3 py-2 border rounded-md"
                        >
                          <option value="plain_text">Plain Text</option>
                          <option value="markdown">Markdown (future)</option>
                          <option value="html">HTML (future)</option>
                        </select>
                      </div>
                      <div>
                        <Label>Episode Content</Label>
                        <textarea
                          value={formData.content}
                          onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                          placeholder="Enter episode content here..."
                          rows={6}
                          className="w-full px-3 py-2 border rounded-md font-mono text-sm"
                        />
                        {formData.content && (
                          <p className="text-xs text-muted-foreground mt-1">
                            ~{Math.round(formData.content.split(/\s+/).length)} words
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData.isPublished}
                          onChange={(e) => setFormData({ ...formData, isPublished: e.target.checked })}
                          id="isPublished"
                        />
                        <Label htmlFor="isPublished" className="cursor-pointer">Published</Label>
                      </div>
                      <div>
                        <Label>Sort Order</Label>
                        <Input
                          type="number"
                          value={formData.sortOrder}
                          onChange={(e) => setFormData({ ...formData, sortOrder: parseInt(e.target.value) || 0 })}
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Save Button */}
                  <Button
                    onClick={handleSubmit}
                    disabled={createMutation.isPending || updateMutation.isPending}
                    className="w-full"
                  >
                    {createMutation.isPending || updateMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
                )}
              </DialogContent>
            </Dialog>
          </div>

          {/* Search and Sort Controls */}
          <div className="flex gap-4 items-end flex-wrap">
            <div className="flex-1 min-w-64">
              <Label htmlFor="search" className="text-sm mb-2 block">
                Search Episodes
              </Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="search"
                  type="text"
                  placeholder="Search by title or episode number..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="sort" className="text-sm mb-2 block">
                Sort By
              </Label>
              <select
                id="sort"
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value as SortOption)}
                className="px-3 py-2 border rounded-md"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="title_asc">Title A-Z</option>
                <option value="title_desc">Title Z-A</option>
              </select>
            </div>
          </div>
        </div>

        {/* Episodes List */}
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : episodesList.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">
              {searchTerm.trim()
                ? "No episodes match your search"
                : isScoped
                  ? "No episodes for this novel yet"
                  : "No episodes found"}
            </p>
          </Card>
        ) : (
          <div className="grid gap-4">
            <div className="text-sm text-muted-foreground">
              Showing {rangeStart}-{rangeEnd} of {total} episode{total !== 1 ? "s" : ""}
            </div>
            {episodesList.map((episode: any) => (
              <Card key={episode.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-lg">{episode.title}</h3>
                      <Badge variant={episode.isFree ? "default" : "secondary"}>
                        {episode.isFree ? "Free" : `฿${episode.price}`}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {episode.saleMode === "package" ? "แพ็กอ่านบนเว็บ" : "รายบท"}
                      </Badge>
                      {episode.hasContent && (
                        <Badge variant="outline" className="text-xs">
                          Content ✓
                        </Badge>
                      )}
                      {!episode.isPublished && (
                        <Badge variant="outline" className="text-xs bg-yellow-50">
                          Draft
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {!isScoped && `${episode.novelTitle} • `}Episode {episode.episodeNumber}
                      {episode.wordCount && ` • ${episode.wordCount} words`}
                    </p>
                    {episode.description && (
                      <p className="text-sm mt-1 text-slate-600">{episode.description}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEdit(episode)}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        if (confirm("Are you sure you want to delete this episode?")) {
                          deleteMutation.mutate({ episodeId: episode.id });
                        }
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}

            {/* Pagination */}
            <div className="flex justify-center items-center gap-4 mt-2">
              <Button
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ก่อนหน้า
              </Button>
              <span className="text-sm text-slate-600">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                ถัดไป
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
